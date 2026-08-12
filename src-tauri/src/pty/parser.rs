//! Incremental parser for OSC 7777 cwd-reporting and cmd-reporting sequences.
//!
//! The terminal's `PROMPT_COMMAND` emits two OSC sequences before every prompt:
//! - `\033]7777;cwd;<path>\007`  — current working directory
//! - `\033]7777;cmd;<command>\007` — the command that was just executed
//!
//! These sequences are invisible to xterm (OSC 7777 is not a recognised
//! command, so xterm silently ignores them). We scan the raw PTY byte stream,
//! extract `<path>` and `<command>`, and strip the sequences from the output
//! we forward to the frontend so they never reach xterm at all.
//!
//! Both BEL (`\007`) and ST (`\033\\`) terminators are recognised.

/// The OSC content prefix that identifies our cwd-reporting sequence
/// (everything between `ESC ]` and the terminator).
const OSC_CWD_PREFIX: &[u8] = b"7777;cwd;";
/// The OSC content prefix that identifies our cmd-reporting sequence.
const OSC_CMD_PREFIX: &[u8] = b"7777;cmd;";

/// Upper bound on the OSC buffer. If an in-progress OSC sequence exceeds this
/// without a terminator we flush it as normal output — it's almost certainly
/// not one of our sequences (which are paths, typically < 4 KiB).
const MAX_OSC_BUFFER: usize = 8192;

const ESC: u8 = 0x1B;
const BEL: u8 = 0x07;
const RSBRACKET: u8 = b']';
const BACKSLASH: u8 = b'\\';

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// Normal output — pass bytes through, watching for ESC.
    Normal,
    /// Saw ESC — waiting for `]` to confirm OSC start.
    Esc,
    /// Inside an OSC sequence — accumulating until BEL or ST.
    Osc,
    /// Inside an OSC, saw ESC — expecting `\` for an ST terminator.
    OscExpectBackslash,
}

/// Streaming parser that strips OSC 7777;cwd; sequences from a byte stream.
///
/// Create one per PTY session and call [`feed`](OscParser::feed) with each
/// chunk received from the channel. Partial sequences that span chunk
/// boundaries are handled correctly — the parser retains internal state.
pub struct OscParser {
    state: State,
    /// Bytes accumulated for the in-progress escape/OSC sequence. Only
    /// non-empty while `state != Normal`.
    buffer: Vec<u8>,
}

impl OscParser {
    pub fn new() -> Self {
        Self {
            state: State::Normal,
            buffer: Vec::new(),
        }
    }

    /// Process a chunk of input bytes.
    ///
    /// Returns `(clean_output, detected_paths, detected_commands)`:
    /// - `clean_output`: the input with any OSC 7777 sequences removed.
    /// - `detected_paths`: absolute directory paths from `7777;cwd;` sequences.
    /// - `detected_commands`: command strings from `7777;cmd;` sequences.
    pub fn feed(&mut self, input: &[u8]) -> (Vec<u8>, Vec<String>, Vec<String>) {
        let mut output = Vec::with_capacity(input.len());
        let mut paths = Vec::new();
        let mut commands = Vec::new();

        for &byte in input {
            self.step(byte, &mut output, &mut paths, &mut commands);
        }

        (output, paths, commands)
    }

    #[inline]
    fn step(
        &mut self,
        byte: u8,
        output: &mut Vec<u8>,
        paths: &mut Vec<String>,
        commands: &mut Vec<String>,
    ) {
        match self.state {
            State::Normal => {
                if byte == ESC {
                    self.buffer.clear();
                    self.buffer.push(ESC);
                    self.state = State::Esc;
                } else {
                    output.push(byte);
                }
            }
            State::Esc => {
                if byte == RSBRACKET {
                    self.buffer.push(byte);
                    self.state = State::Osc;
                } else {
                    // Not an OSC — emit the ESC we held back, then reprocess
                    // the current byte in Normal state.
                    output.push(ESC);
                    self.buffer.clear();
                    self.state = State::Normal;
                    self.step(byte, output, paths, commands);
                }
            }
            State::Osc => {
                if byte == BEL {
                    self.buffer.push(byte);
                    self.finish_osc(output, paths, commands, /* st_terminated */ false);
                    self.buffer.clear();
                    self.state = State::Normal;
                } else if byte == ESC {
                    // Could be the start of an ST terminator (ESC \).
                    self.buffer.push(byte);
                    self.state = State::OscExpectBackslash;
                } else {
                    self.buffer.push(byte);
                    if self.buffer.len() > MAX_OSC_BUFFER {
                        // Too long — not one of our sequences; flush.
                        output.extend_from_slice(&self.buffer);
                        self.buffer.clear();
                        self.state = State::Normal;
                    }
                }
            }
            State::OscExpectBackslash => {
                if byte == BACKSLASH {
                    // ST terminator (ESC \) — sequence complete.
                    self.buffer.push(byte);
                    self.finish_osc(output, paths, commands, /* st_terminated */ true);
                    self.buffer.clear();
                    self.state = State::Normal;
                } else {
                    // The ESC wasn't part of ST. Emit everything we held back
                    // up to (but not including) that ESC, then reprocess the
                    // ESC + current byte from the Esc state.
                    let esc_idx = self.buffer.len() - 1;
                    output.extend_from_slice(&self.buffer[..esc_idx]);
                    self.buffer.clear();
                    self.buffer.push(ESC);
                    self.state = State::Esc;
                    self.step(byte, output, paths, commands);
                }
            }
        }
    }

    /// Inspect a completed OSC sequence held in `self.buffer`. If it matches
    /// our `7777;cwd;` or `7777;cmd;` prefix, push the extracted value into
    /// the corresponding vector; otherwise copy the raw bytes into `output`
    /// so the terminal sees them unchanged.
    fn finish_osc(
        &self,
        output: &mut Vec<u8>,
        paths: &mut Vec<String>,
        commands: &mut Vec<String>,
        st_terminated: bool,
    ) {
        // buffer layout: [ESC, ']'] + content + terminator
        //   terminator is BEL (1 byte) or ESC \ (2 bytes).
        let term_len = if st_terminated { 2 } else { 1 };
        let content = &self.buffer[2..self.buffer.len() - term_len];

        if let Some(path_bytes) = content.strip_prefix(OSC_CWD_PREFIX) {
            if let Ok(path_str) = std::str::from_utf8(path_bytes) {
                paths.push(path_str.to_string());
            }
            // Strip — do not emit to the terminal.
        } else if let Some(cmd_bytes) = content.strip_prefix(OSC_CMD_PREFIX) {
            if let Ok(cmd_str) = std::str::from_utf8(cmd_bytes) {
                commands.push(cmd_str.to_string());
            }
            // Strip — do not emit to the terminal.
        } else {
            // Not our sequence — pass through verbatim.
            output.extend_from_slice(&self.buffer);
        }
    }
}

impl Default for OscParser {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_passes_through() {
        let mut p = OscParser::new();
        let (out, paths, cmds) = p.feed(b"hello world");
        assert_eq!(out, b"hello world");
        assert!(paths.is_empty());
        assert!(cmds.is_empty());
    }

    #[test]
    fn extracts_cwd_and_strips_sequence() {
        let mut p = OscParser::new();
        let input = b"before\x1b]7777;cwd;/home/user\x07after";
        let (out, paths, _) = p.feed(input);
        assert_eq!(out, b"beforeafter");
        assert_eq!(paths, vec!["/home/user".to_string()]);
    }

    #[test]
    fn handles_st_terminator() {
        let mut p = OscParser::new();
        let input = b"\x1b]7777;cwd;/var/log\x1b\\";
        let (out, paths, _) = p.feed(input);
        assert_eq!(out, b"");
        assert_eq!(paths, vec!["/var/log".to_string()]);
    }

    #[test]
    fn sequence_split_across_chunks() {
        let mut p = OscParser::new();
        let (out1, paths1, _) = p.feed(b"text\x1b]7777;cwd;/tmp");
        assert_eq!(out1, b"text");
        assert!(paths1.is_empty());
        let (out2, paths2, _) = p.feed(b"/sub\x07more");
        assert_eq!(out2, b"more");
        assert_eq!(paths2, vec!["/tmp/sub".to_string()]);
    }

    #[test]
    fn non_cwd_osc_passes_through() {
        let mut p = OscParser::new();
        // OSC 0 (set window title) — should be forwarded to the terminal.
        let input = b"\x1b]0;my title\x07";
        let (out, paths, _) = p.feed(input);
        assert_eq!(out, input);
        assert!(paths.is_empty());
    }

    #[test]
    fn multiple_sequences_in_one_chunk() {
        let mut p = OscParser::new();
        let input = b"\x1b]7777;cwd;/a\x07mid\x1b]7777;cwd;/b\x07";
        let (out, paths, _) = p.feed(input);
        assert_eq!(out, b"mid");
        assert_eq!(paths, vec!["/a".to_string(), "/b".to_string()]);
    }

    #[test]
    fn bare_esc_is_emitted() {
        let mut p = OscParser::new();
        // ESC not followed by ] — should pass through.
        let (out, _, _) = p.feed(b"\x1b[31m");
        assert_eq!(out, b"\x1b[31m");
    }

    #[test]
    fn empty_path_is_extracted() {
        let mut p = OscParser::new();
        let (out, paths, _) = p.feed(b"\x1b]7777;cwd;\x07");
        assert_eq!(out, b"");
        assert_eq!(paths, vec!["".to_string()]);
    }

    #[test]
    fn extracts_cmd_and_strips_sequence() {
        let mut p = OscParser::new();
        let input = b"\x1b]7777;cmd;pm2 logs 13\x07";
        let (out, _, cmds) = p.feed(input);
        assert_eq!(out, b"");
        assert_eq!(cmds, vec!["pm2 logs 13".to_string()]);
    }

    #[test]
    fn cwd_and_cmd_together() {
        let mut p = OscParser::new();
        let input = b"\x1b]7777;cwd;/home/user\x07\x1b]7777;cmd;ls -la\x07";
        let (out, paths, cmds) = p.feed(input);
        assert_eq!(out, b"");
        assert_eq!(paths, vec!["/home/user".to_string()]);
        assert_eq!(cmds, vec!["ls -la".to_string()]);
    }
}

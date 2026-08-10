import { createPortal } from 'react-dom';
import { X, Sparkles, Download, ChevronRight, Check } from 'lucide-react';
import {
  useAppUpdater,
  UPDATE_MIRROR_OPTIONS,
  type UpdateMirror,
} from '../hooks/useAppUpdater';

/**
 * 简单的行内 markdown → HTML（仅支持无序列表、有序列表、粗体、换行）。
 * 不引入 marked/remark 等库，控制打包体积。
 */
function renderNotes(notes: string | null): string {
  if (!notes) return '';
  const escape = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const lines = notes.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inUl = false;
  let inOl = false;

  const closeLists = () => {
    if (inUl) {
      out.push('</ul>');
      inUl = false;
    }
    if (inOl) {
      out.push('</ol>');
      inOl = false;
    }
  };

  for (let raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeLists();
      out.push('<br/>');
      continue;
    }
    // 标题：### / ## / #
    let m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      closeLists();
      const level = m[1].length;
      out.push(`<h${level + 1} class="notes-h">${escape(m[2])}</h${level + 1}>`);
      continue;
    }
    // 无序列表：- / * / +
    m = line.match(/^[-*+]\s+(.*)$/);
    if (m) {
      if (inOl) {
        out.push('</ol>');
        inOl = false;
      }
      if (!inUl) {
        out.push('<ul class="notes-ul">');
        inUl = true;
      }
      let content = escape(m[1]);
      content = content.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      out.push(`<li>${content}</li>`);
      continue;
    }
    // 有序列表：1. 2.
    m = line.match(/^\d+\.\s+(.*)$/);
    if (m) {
      if (inUl) {
        out.push('</ul>');
        inUl = false;
      }
      if (!inOl) {
        out.push('<ol class="notes-ol">');
        inOl = true;
      }
      let content = escape(m[1]);
      content = content.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      out.push(`<li>${content}</li>`);
      continue;
    }
    // 普通段落
    closeLists();
    let content = escape(line);
    content = content.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    out.push(`<p class="notes-p">${content}</p>`);
  }
  closeLists();
  return out.join('\n');
}

export function UpdateDialog() {
  const updater = useAppUpdater();

  if (!updater.dialogVisible) return null;

  const notesHTML = renderNotes(updater.releaseNotes);
  const hasRealTotal = updater.totalMB && updater.totalMB > 0;

  const handleInstall = () => {
    void updater.install();
  };

  const handleClose = () => {
    updater.hideDialog();
  };

  return createPortal(
    <div
      className="dialog-overlay update-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-dialog-title"
      onClick={handleClose}
    >
      <div className="dialog dialog-update" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <div className="update-dialog-title-wrap">
            <Sparkles size={18} className="update-dialog-spark" />
            <h2 id="update-dialog-title" className="dialog-title">
              发现新版本
            </h2>
          </div>
          <button
            type="button"
            className="dialog-close"
            aria-label="关闭"
            onClick={handleClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="dialog-body update-dialog-body">
          <div className="update-version-row">
            <div className="update-version-block">
              <div className="update-version-label">当前版本</div>
              <div className="update-version-value update-version-current">
                v{updater.currentVersion ?? '--'}
              </div>
            </div>
            <ChevronRight size={20} className="update-version-arrow" />
            <div className="update-version-block">
              <div className="update-version-label">最新版本</div>
              <div className="update-version-value update-version-latest">
                v{updater.availableVersion ?? '--'}
              </div>
            </div>
            {hasRealTotal && (
              <div className="update-version-block update-version-size">
                <div className="update-version-label">安装包大小</div>
                <div className="update-version-value">{updater.totalMB} MB</div>
              </div>
            )}
          </div>

          <div className="update-notes-section">
            <div className="update-notes-title">本次更新内容</div>
            {notesHTML ? (
              <div
                className="update-notes-content markdown-body"
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: notesHTML }}
              />
            ) : (
              <div className="update-notes-empty">
                该版本暂无详细更新说明，或更新说明正在同步中。
                <br />
                可前往 GitHub Release 页面查看更多细节。
              </div>
            )}
          </div>

          <div className="update-mirror-section">
            <div className="update-mirror-title">下载源（国内网络建议选择镜像加速）</div>
            <div className="update-mirror-grid">
              {UPDATE_MIRROR_OPTIONS.map((opt) => {
                const selected = updater.mirror === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    className={`mirror-card ${selected ? 'is-selected' : ''}`}
                    onClick={() => updater.changeMirror(opt.id as UpdateMirror)}
                    aria-pressed={selected}
                  >
                    <div className="mirror-card-header">
                      <span className="mirror-card-name">{opt.name}</span>
                      {selected && <Check size={14} className="mirror-card-check" />}
                    </div>
                    <div className="mirror-card-desc">{opt.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="dialog-footer update-dialog-footer">
          <button type="button" className="btn btn-ghost" onClick={handleClose}>
            稍后更新
          </button>
          <button
            type="button"
            className="btn btn-primary update-dialog-install-btn"
            onClick={handleInstall}
          >
            <Download size={14} />
            <span>立即下载并安装</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

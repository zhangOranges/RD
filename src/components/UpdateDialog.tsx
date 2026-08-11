import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Sparkles,
  Download,
  ChevronRight,
  Check,
  PackageCheck,
  DownloadCloud,
  RefreshCw,
  AlertTriangle,
  FolderOpen,
} from 'lucide-react';
import {
  useAppUpdater,
  getMirrorOptions,
  type UpdateMirror,
  type MirrorOption,
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
  const [mirrorOptions, setMirrorOptions] = useState<MirrorOption[]>([]);

  useEffect(() => {
    setMirrorOptions(getMirrorOptions());
  }, [updater.dialogVisible]);

  if (!updater.dialogVisible) return null;

  const notesHTML = renderNotes(updater.releaseNotes);
  const hasRealTotal = updater.totalMB && updater.totalMB > 0;

  const status = updater.status;
  const isAvailable = status === 'available';
  const isDownloading = status === 'downloading';
  const isDownloaded = status === 'downloaded'; // 下载完成，待确认安装
  const isInstalling = status === 'installing';
  const isError = status === 'error';

  // 标题
  let title = '发现新版本';
  if (isDownloading) title = '正在下载更新';
  else if (isDownloaded) title = '更新包已下载完成';
  else if (isInstalling) title = '正在安装更新';
  else if (isError) title = '更新失败';

  // 安装中禁用关闭按钮（安装过程不可打断）；下载中允许关闭，继续后台下载
  const closeDisabled = isInstalling;

  const handleDownload = () => {
    void updater.download();
  };

  const handleInstall = () => {
    void updater.install();
  };

  const handleInstallLater = () => {
    updater.installLater();
  };

  const handleOpenFolder = () => {
    void updater.openFolder();
  };

  const handleClose = () => {
    if (closeDisabled) return;
    updater.hideDialog();
  };

  // 错误重试：如果已有可用版本号，说明是下载失败，重试下载；否则重试检查
  const handleErrorRetry = () => {
    updater.dismissError();
    if (updater.availableVersion) {
      void updater.download();
    } else {
      void updater.check();
    }
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
            {isError ? (
              <AlertTriangle size={18} className="update-dialog-spark update-dialog-icon-error" />
            ) : isDownloaded ? (
              <PackageCheck size={18} className="update-dialog-spark update-dialog-icon-ready" />
            ) : isDownloading ? (
              <RefreshCw size={18} className="update-dialog-spark spin" />
            ) : isInstalling ? (
              <DownloadCloud size={18} className="update-dialog-spark" />
            ) : (
              <Sparkles size={18} className="update-dialog-spark" />
            )}
            <h2 id="update-dialog-title" className="dialog-title">
              {title}
            </h2>
          </div>
          <button
            type="button"
            className="dialog-close"
            aria-label="关闭"
            onClick={handleClose}
            disabled={closeDisabled}
            style={closeDisabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
          >
            <X size={16} />
          </button>
        </div>

        <div className="dialog-body update-dialog-body">
          {/* 错误状态：显示错误详情 */}
          {isError && (
            <div className="update-banner update-banner-error">
              <AlertTriangle size={14} />
              <div className="update-banner-error-detail">
                <div className="update-banner-error-title">检查或下载更新时出错：</div>
                <pre className="update-banner-error-msg">{updater.errorMsg ?? '未知错误'}</pre>
              </div>
            </div>
          )}

          {/* 下载中提示条：提示用户进度在状态栏 */}
          {isDownloading && (
            <div className="update-banner update-banner-downloading">
              <RefreshCw size={14} className="spin" />
              <span>
                {updater.progressPct === 0
                  ? '正在获取下载地址，请稍候…可关闭此对话框继续使用。'
                  : '正在后台下载更新，可关闭此对话框继续使用。下载进度可在右下角状态栏查看，下载完成后将自动弹出确认。'}
              </span>
            </div>
          )}

          {/* 下载完成提示条 */}
          {isDownloaded && !isInstalling && (
            <div
              className={`update-banner ${
                updater.pendingFromLocal
                  ? 'update-banner-pending'
                  : 'update-banner-ready'
              }`}
            >
              <PackageCheck size={14} />
              <span>
                {updater.pendingFromLocal
                  ? '检测到上次已下载的更新包，版本匹配，可直接安装。'
                  : '更新包已下载完成，安装后程序将自动重启。请选择安装时机。'}
              </span>
            </div>
          )}

          {/* 安装中提示条 */}
          {isInstalling && (
            <div className="update-banner update-banner-installing">
              <DownloadCloud size={14} />
              <span>正在安装新版本，请不要关闭程序，完成后将自动重启。</span>
            </div>
          )}

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

          {/* 仅"有新版本可用"且尚未开始下载时显示镜像选择 */}
          {isAvailable && (
            <div className="update-mirror-section">
              <div className="update-mirror-title">下载源（国内网络建议选择镜像加速）</div>
              <div className="update-mirror-grid">
                {mirrorOptions.map((opt) => {
                  const selected = updater.mirror === opt.id;
                  const delay = updater.mirrorDelays?.[opt.id];
                  let delayLabel: string;
                  let delayClass: string;
                  if (delay === undefined || delay === null) {
                    delayLabel = '不可达';
                    delayClass = 'mirror-delay mirror-delay-bad';
                  } else if (delay < 0) {
                    delayLabel = '超时';
                    delayClass = 'mirror-delay mirror-delay-bad';
                  } else if (delay < 300) {
                    delayLabel = `${delay} ms`;
                    delayClass = 'mirror-delay mirror-delay-good';
                  } else if (delay < 1000) {
                    delayLabel = `${delay} ms`;
                    delayClass = 'mirror-delay mirror-delay-ok';
                  } else {
                    delayLabel = `${(delay / 1000).toFixed(1)} s`;
                    delayClass = 'mirror-delay mirror-delay-bad';
                  }
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
                        <div className="mirror-card-right">
                          <span className={delayClass}>{delayLabel}</span>
                          {selected && <Check size={14} className="mirror-card-check" />}
                        </div>
                      </div>
                      <div className="mirror-card-desc">{opt.desc}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* 底部按钮区域：根据状态渲染不同内容 */}
        <div className="dialog-footer update-dialog-footer">
          {/* 有新版本可用 → 开始后台下载 */}
          {isAvailable && (
            <>
              <button type="button" className="btn btn-ghost" onClick={handleClose}>
                稍后再说
              </button>
              <button
                type="button"
                className="btn btn-primary update-dialog-install-btn"
                onClick={handleDownload}
              >
                <Download size={14} />
                <span>后台下载更新</span>
              </button>
            </>
          )}

          {/* 下载中 → 显示状态 + 允许关闭 */}
          {isDownloading && (
            <div className="update-footer-busy update-footer-downloading">
              <RefreshCw size={12} className="spin" />
              <span>
                下载中 {updater.progressPct || 0}%
                {hasRealTotal
                  ? ` · ${updater.downloadedMB || 0}/${updater.totalMB} MB`
                  : ` · ${updater.downloadedMB || 0} MB`}
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={handleClose}>
                后台下载
              </button>
            </div>
          )}

          {/* 下载完成 → 打开文件夹 / 下次启动安装 / 立即安装 */}
          {isDownloaded && !isInstalling && (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={handleOpenFolder}
                title="在文件管理器中打开安装包所在目录"
              >
                <FolderOpen size={14} />
                <span>打开文件夹</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={handleInstallLater}
                title="保留已下载的更新包，下次启动时再次提示安装"
              >
                下次启动时安装
              </button>
              <button
                type="button"
                className="btn btn-primary update-dialog-install-btn"
                onClick={handleInstall}
              >
                <PackageCheck size={14} />
                <span>立即安装并重启</span>
              </button>
            </>
          )}

          {/* 安装中 → 仅状态展示 */}
          {isInstalling && (
            <div className="update-footer-busy update-footer-installing">
              <DownloadCloud size={12} />
              <span>安装中，完成后程序将自动退出…</span>
            </div>
          )}

          {/* 错误 → 重试 + 关闭 */}
          {isError && (
            <>
              <button type="button" className="btn btn-ghost" onClick={handleClose}>
                关闭
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleErrorRetry}
              >
                <RefreshCw size={14} />
                <span>{updater.availableVersion ? '重新下载' : '重试'}</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

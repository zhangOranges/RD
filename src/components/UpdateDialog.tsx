import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
  let title = t('update.title');
  if (isDownloading) title = t('update.downloadingTitle');
  else if (isDownloaded) title = t('update.downloadedTitle');
  else if (isInstalling) title = t('update.installingTitle');
  else if (isError) title = t('update.errorTitle');

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
            aria-label={t('update.close')}
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
                <div className="update-banner-error-title">{t('update.errorBannerTitle')}</div>
                <pre className="update-banner-error-msg">{updater.errorMsg ?? t('update.unknownError')}</pre>
              </div>
            </div>
          )}

          {/* 下载中提示条：提示用户进度在状态栏 */}
          {isDownloading && (
            <div className="update-banner update-banner-downloading">
              <RefreshCw size={14} className="spin" />
              <span>
                {updater.progressPct === 0
                  ? t('update.gettingDownloadUrl')
                  : t('update.backgroundDownloading')}
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
                  ? t('update.pendingFromLocal')
                  : t('update.downloadedReady')}
              </span>
            </div>
          )}

          {/* 安装中提示条 */}
          {isInstalling && (
            <div className="update-banner update-banner-installing">
              <DownloadCloud size={14} />
              <span>{t('update.installingHint')}</span>
            </div>
          )}

          <div className="update-version-row">
            <div className="update-version-block">
              <div className="update-version-label">{t('update.currentVersion')}</div>
              <div className="update-version-value update-version-current">
                v{updater.currentVersion ?? '--'}
              </div>
            </div>
            <ChevronRight size={20} className="update-version-arrow" />
            <div className="update-version-block">
              <div className="update-version-label">{t('update.latestVersion')}</div>
              <div className="update-version-value update-version-latest">
                v{updater.availableVersion ?? '--'}
              </div>
            </div>
            {hasRealTotal && (
              <div className="update-version-block update-version-size">
                <div className="update-version-label">{t('update.packageSize')}</div>
                <div className="update-version-value">{updater.totalMB} MB</div>
              </div>
            )}
          </div>

          <div className="update-notes-section">
            <div className="update-notes-title">{t('update.notesTitle')}</div>
            {notesHTML ? (
              <div
                className="update-notes-content markdown-body"
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: notesHTML }}
              />
            ) : (
              <div className="update-notes-empty">
                {t('update.notesEmpty')}
                <br />
                {t('update.notesEmptyGithub')}
              </div>
            )}
          </div>

          {/* 仅"有新版本可用"且尚未开始下载时显示镜像选择 */}
          {isAvailable && (
            <div className="update-mirror-section">
              <div className="update-mirror-title">{t('update.mirrorTitle')}</div>
              <div className="update-mirror-grid">
                {mirrorOptions.map((opt) => {
                  const selected = updater.mirror === opt.id;
                  const delay = updater.mirrorDelays?.[opt.id];
                  let delayLabel: string;
                  let delayClass: string;
                  if (delay === undefined || delay === null) {
                    delayLabel = t('update.mirrorUnreachable');
                    delayClass = 'mirror-delay mirror-delay-bad';
                  } else if (delay < 0) {
                    delayLabel = t('update.mirrorTimeout');
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
                {t('update.laterBtn')}
              </button>
              <button
                type="button"
                className="btn btn-primary update-dialog-install-btn"
                onClick={handleDownload}
              >
                <Download size={14} />
                <span>{t('update.backgroundDownload')}</span>
              </button>
            </>
          )}

          {/* 下载中 → 显示状态 + 允许关闭 */}
          {isDownloading && (
            <div className="update-footer-busy update-footer-downloading">
              <RefreshCw size={12} className="spin" />
              <span>
                {t('update.downloadingPct', { pct: updater.progressPct || 0 })}
                {hasRealTotal
                  ? ` · ${updater.downloadedMB || 0}/${updater.totalMB} MB`
                  : ` · ${updater.downloadedMB || 0} MB`}
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={handleClose}>
                {t('update.backgroundDownloadBtn')}
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
                title={t('update.openFolderTitle')}
              >
                <FolderOpen size={14} />
                <span>{t('update.openFolder')}</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={handleInstallLater}
                title={t('update.installLaterTitle')}
              >
                {t('update.installLater')}
              </button>
              <button
                type="button"
                className="btn btn-primary update-dialog-install-btn"
                onClick={handleInstall}
              >
                <PackageCheck size={14} />
                <span>{t('update.installAndRestart')}</span>
              </button>
            </>
          )}

          {/* 安装中 → 仅状态展示 */}
          {isInstalling && (
            <div className="update-footer-busy update-footer-installing">
              <DownloadCloud size={12} />
              <span>{t('update.installingExit')}</span>
            </div>
          )}

          {/* 错误 → 重试 + 关闭 */}
          {isError && (
            <>
              <button type="button" className="btn btn-ghost" onClick={handleClose}>
                {t('update.close')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleErrorRetry}
              >
                <RefreshCw size={14} />
                <span>{updater.availableVersion ? t('update.redownload') : t('update.retry')}</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

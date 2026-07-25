import { useMemo, useState } from 'react';

const ZOOM_STEPS = [50, 65, 75, 85, 100, 115, 130, 150, 175, 200];

function stepZoom(current: number, direction: 1 | -1): number {
  const exact = ZOOM_STEPS.indexOf(current);
  const index = exact >= 0 ? exact : ZOOM_STEPS.findIndex((step) => step >= current);
  if (direction === 1) {
    return ZOOM_STEPS[Math.min(index < 0 ? ZOOM_STEPS.length - 1 : index + 1, ZOOM_STEPS.length - 1)];
  }
  return ZOOM_STEPS[Math.max(index <= 0 ? 0 : index - 1, 0)];
}

function Icon({
  children,
  label,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-ink disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function DocumentPreview({
  url,
  fileName,
  contentType,
  loading,
  error,
}: {
  url?: string;
  fileName: string;
  contentType?: string;
  loading?: boolean;
  error?: string;
}) {
  const [zoom, setZoom] = useState(100);
  const [page, setPage] = useState(1);
  const path = (url ?? '').split('?')[0].split('#')[0];
  const isImage =
    contentType?.toLowerCase().startsWith('image/') ||
    /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i.test(fileName) ||
    /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i.test(path);

  const iframeUrl = useMemo(() => {
    if (!url || isImage) return undefined;
    return `${url}#page=${page}&zoom=${zoom}`;
  }, [isImage, page, url, zoom]);

  const download = () => {
    if (!url) return;
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.target = '_blank';
    anchor.rel = 'noreferrer';
    anchor.click();
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-b border-line bg-white lg:border-b-0 lg:border-r">
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-line px-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{fileName}</p>
          <p className="text-[11px] text-muted">{isImage ? 'Imagine originală' : `PDF · pagina ${page}`}</p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {!isImage && (
            <div className="mr-1 flex items-center rounded-lg border border-line-strong bg-white">
              <Icon label="Pagina anterioară" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </Icon>
              <span className="min-w-7 text-center text-xs font-semibold tabular-nums text-ink-soft">{page}</span>
              <Icon label="Pagina următoare" onClick={() => setPage((value) => value + 1)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </Icon>
            </div>
          )}

          <div className="flex items-center rounded-lg border border-line-strong bg-white">
            <Icon label="Micșorează" onClick={() => setZoom((value) => stepZoom(value, -1))}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="7" />
                <path d="M8 11h6M20 20l-4-4" />
              </svg>
            </Icon>
            <span className="min-w-10 text-center text-[11px] font-semibold tabular-nums text-ink-soft">{zoom}%</span>
            <Icon label="Mărește" onClick={() => setZoom((value) => stepZoom(value, 1))}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="7" />
                <path d="M8 11h6M11 8v6M20 20l-4-4" />
              </svg>
            </Icon>
          </div>

          <Icon label="Descarcă documentul" onClick={download} disabled={!url}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 19h14" />
            </svg>
          </Icon>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-canvas p-3 md:p-5">
        {loading && (
          <div className="flex h-full min-h-48 items-center justify-center text-sm text-muted">
            Se încarcă documentul…
          </div>
        )}
        {!loading && error && (
          <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm font-semibold text-ink-soft">Documentul nu poate fi previzualizat.</p>
            <p className="max-w-sm text-xs text-muted">{error}</p>
          </div>
        )}
        {!loading && !error && url && isImage && (
          <div className="flex min-h-full min-w-full items-start justify-center">
            <img
              src={url}
              alt={fileName}
              draggable={false}
              className="block max-w-none rounded-lg bg-white shadow-[0_12px_32px_rgba(15,15,25,0.14)]"
              style={{ width: `${zoom}%` }}
            />
          </div>
        )}
        {!loading && !error && iframeUrl && (
          <iframe
            key={iframeUrl}
            src={iframeUrl}
            title={fileName}
            className="h-full min-h-[420px] w-full rounded-lg bg-white shadow-[0_12px_32px_rgba(15,15,25,0.14)]"
          />
        )}
      </div>
    </section>
  );
}

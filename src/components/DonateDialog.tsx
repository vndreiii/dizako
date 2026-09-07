import { useState } from "react";
import { DONATE_URL } from "../donate";
import { useI18n } from "../i18n";
import { IconClose, IconFavorite } from "./Icons";
import { Button } from "./primitives";

interface Props {
  onClose: () => void;
}

/** Shown when the system browser could not be opened for donations. */
export function DonateDialog({ onClose }: Props) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(DONATE_URL);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Last resort: select-friendly prompt is worse UX; leave button idle.
    }
  };

  return (
    <div className="sheet-scrim" onPointerDown={onClose}>
      <div
        className="sheet sheet--donate"
        role="dialog"
        aria-modal="true"
        aria-label={t("donate.dialogAria")}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="sheet__header">
          <h2 className="sheet__title">{t("donate.title")}</h2>
          <button className="sheet__close" onClick={onClose} aria-label={t("donate.close")}>
            <IconClose />
          </button>
        </header>

        <div className="donate-dialog__body">
          <span className="donate-dialog__icon" aria-hidden="true">
            <IconFavorite />
          </span>
          <p className="donate-dialog__message">{t("donate.message")}</p>
          <p className="donate-dialog__url">{DONATE_URL}</p>
        </div>

        <footer className="sheet__foot">
          <Button variant="outlined" onClick={onClose}>
            {t("donate.close")}
          </Button>
          <Button variant="donate" icon={<IconFavorite />} onClick={() => void copyUrl()}>
            {copied ? t("donate.copied") : t("donate.copy")}
          </Button>
        </footer>
      </div>
    </div>
  );
}

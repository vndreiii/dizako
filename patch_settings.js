const fs = require('fs');
let content = fs.readFileSync('src/components/SettingsSheet.tsx', 'utf8');

if (!content.includes('useI18n')) {
  content = content.replace(
    'import { SEED_PRESETS',
    `import { useI18n } from "../i18n";\nimport { SEED_PRESETS`
  );

  content = content.replace(
    '  const panelRef = useRef<HTMLDivElement>(null);',
    '  const panelRef = useRef<HTMLDivElement>(null);\n  const { t, locale, setLocale } = useI18n();'
  );

  // Add Language section
  const languageSection = `
          <div className="setting">
            <div className="setting__text">
              <span className="setting__label">{t('settings.language')}</span>
              <span className="setting__hint">{t('settings.languageHint')}</span>
            </div>
            <div className="m3-segmented" role="group">
              <button
                className={\`m3-segmented__item \${locale === "en" ? "is-selected" : ""}\`}
                onClick={() => setLocale("en")}
              >
                EN
              </button>
              <button
                className={\`m3-segmented__item \${locale === "es" ? "is-selected" : ""}\`}
                onClick={() => setLocale("es")}
              >
                ES
              </button>
              <button
                className={\`m3-segmented__item \${locale === "fr" ? "is-selected" : ""}\`}
                onClick={() => setLocale("fr")}
              >
                FR
              </button>
            </div>
          </div>
`;

  content = content.replace(
    '        </section>\n      </div>',
    `${languageSection}        </section>\n      </div>`
  );

  fs.writeFileSync('src/components/SettingsSheet.tsx', content, 'utf8');
}

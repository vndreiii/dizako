import fs from 'fs';

let content = fs.readFileSync('src/components/SettingsSheet.tsx', 'utf8');

const matugenButton = `
              <button
                className={\`m3-segmented__item \${source === "matugen" ? "is-selected" : ""}\`}
                aria-pressed={source === "matugen"}
                onClick={() => onSource("matugen")}
              >
                <span className="m3-segmented__icon">
                  <IconAuto />
                </span>
                Matugen
              </button>
`;

if (!content.includes('"matugen"')) {
  content = content.replace(
    '</button>\n            </div>\n          </div>',
    '</button>' + matugenButton + '            </div>\n          </div>'
  );
  fs.writeFileSync('src/components/SettingsSheet.tsx', content, 'utf8');
}

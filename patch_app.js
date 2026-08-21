import fs from 'fs';

let content = fs.readFileSync('src/App.tsx', 'utf8');

content = content.replace(
  'import {\n  applyTheme,\n  DEFAULT_SEED,\n  seedFromImageData,\n  type Mode,\n  type ThemeSource,\n} from "./theme/theme";',
  'import {\n  applyTheme,\n  applyMatugenTheme,\n  DEFAULT_SEED,\n  seedFromImageData,\n  type Mode,\n  type ThemeSource,\n} from "./theme/theme";'
);

const newEffect = `
  useEffect(() => {
    if (themeSource === "matugen") {
      Promise.all([
        import("@tauri-apps/plugin-fs"),
        import("@tauri-apps/api/path")
      ]).then(([{ readTextFile }, { BaseDirectory }]) => {
        readTextFile("colors.json", { baseDir: BaseDirectory.AppConfig })
          .then((text) => {
            try {
              const colors = JSON.parse(text);
              applyMatugenTheme(colors, mode);
            } catch (e) {
              console.error("Invalid matugen colors.json", e);
              applyTheme({ seed: activeSeed, mode });
            }
          })
          .catch((err) => {
            console.error("Could not read matugen colors.json", err);
            applyTheme({ seed: activeSeed, mode });
          });
      }).catch((err) => {
        console.error("Tauri APIs not available", err);
        applyTheme({ seed: activeSeed, mode });
      });
    } else {
      applyTheme({ seed: activeSeed, mode });
    }
  }, [themeSource, activeSeed, mode]);
`;

content = content.replace(
  'useEffect(() => applyTheme({ seed: activeSeed, mode }), [activeSeed, mode]);',
  newEffect.trim()
);

fs.writeFileSync('src/App.tsx', content, 'utf8');

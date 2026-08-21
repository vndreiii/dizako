import fs from 'fs';

let content = fs.readFileSync('src/theme/theme.ts', 'utf8');

// Update ThemeSource
content = content.replace(
  'export type ThemeSource = "preset" | "dynamic";',
  'export type ThemeSource = "preset" | "dynamic" | "matugen";'
);

// Add applyMatugenTheme
const matugenFunc = `
export function applyMatugenTheme(colors: Record<string, string>, mode: Mode): void {
  const root = document.documentElement;

  for (const [key, value] of Object.entries(colors)) {
    const varName = ROLE_KEYS.includes(key as any) ? kebab(key) : key;
    root.style.setProperty(\`--md-sys-color-\${varName}\`, value);
  }

  root.style.colorScheme = mode;
  root.dataset.theme = mode;
}
`;
if (!content.includes('applyMatugenTheme')) {
  content += matugenFunc;
}

fs.writeFileSync('src/theme/theme.ts', content, 'utf8');

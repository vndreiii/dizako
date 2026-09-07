import type { Palette } from "./types";

/** Evenly spaced neutral ramp. */
function ramp(steps: number): string[] {
  return Array.from({ length: steps }, (_, i) => {
    const v = Math.round((i / (steps - 1)) * 255);
    const h = v.toString(16).padStart(2, "0");
    return `#${h}${h}${h}`;
  });
}

/** Ramp between two colours in linear RGB, which keeps midpoints from muddying. */
function gradient(from: string, to: string, steps: number): string[] {
  const parse = (hex: string) => {
    const h = hex.replace("#", "");
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  };
  const [r1, g1, b1] = parse(from);
  const [r2, g2, b2] = parse(to);
  const lin = (v: number) => Math.pow(v / 255, 2.2);
  const enc = (v: number) => Math.round(Math.pow(v, 1 / 2.2) * 255);
  return Array.from({ length: steps }, (_, i) => {
    const t = i / (steps - 1);
    const mix = (a: number, b: number) => enc(lin(a) * (1 - t) + lin(b) * t);
    const c = [mix(r1, r2), mix(g1, g2), mix(b1, b2)];
    return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  });
}

export const PALETTE_GROUPS: Array<{ group: string; palettes: Palette[] }> = [
  {
    group: "Monochrome",
    palettes: [
      { name: "Black & White", colors: ["#000000", "#FFFFFF"] },
      { name: "Grayscale 3", colors: ramp(3) },
      { name: "Grayscale 4", colors: ramp(4) },
      { name: "Grayscale 6", colors: ramp(6) },
      { name: "Grayscale 8", colors: ramp(8) },
      { name: "Grayscale 16", colors: ramp(16) },
      { name: "Ink & Paper", colors: ["#1A1A1A", "#F4F1EA"] },
      { name: "Newsprint", colors: ["#14110F", "#5C5651", "#B8B2A7", "#EDE8DE"] },
      { name: "Blueprint", colors: ["#0B3D91", "#E8F1FF"] },
      { name: "Pencil", colors: gradient("#1C1B1A", "#EEEDE9", 6) },
      { name: "Charcoal", colors: gradient("#0A0A0B", "#B7B3AC", 5) },
      { name: "High Key", colors: ["#8E8E8E", "#BDBDBD", "#E4E4E4", "#FFFFFF"] },
      { name: "Low Key", colors: ["#000000", "#111111", "#232323", "#3A3A3A"] },
    ],
  },
  {
    group: "Consoles",
    palettes: [
      { name: "Game Boy", colors: ["#0F380F", "#306230", "#8BAC0F", "#9BBC0F"] },
      { name: "Game Boy Pocket", colors: ["#2B2B26", "#6E6E5F", "#A8A891", "#C4CFA1"] },
      { name: "Game Boy Light", colors: ["#00443C", "#00786A", "#009C8C", "#00B581"] },
      { name: "Virtual Boy", colors: ["#000000", "#550000", "#AA0000", "#FF0000"] },
      {
        name: "NES",
        colors: [
          "#7C7C7C", "#0000FC", "#0000BC", "#4428BC", "#940084", "#A80020", "#A81000", "#881400",
          "#503000", "#007800", "#006800", "#005800", "#004058", "#000000", "#BCBCBC", "#0078F8",
          "#0058F8", "#6844FC", "#D800CC", "#E40058", "#F83800", "#E45C10", "#AC7C00", "#00B800",
          "#00A800", "#00A844", "#008888", "#F8F8F8", "#3CBCFC", "#6888FC", "#9878F8", "#F878F8",
        ],
      },
      { name: "Master System", colors: ["#000000", "#5500AA", "#AA0055", "#FF55AA", "#00AA55", "#55FFAA", "#AAFF55", "#FFFFFF"] },
      { name: "Neo Geo Pocket", colors: ["#0F1811", "#3A5A40", "#8CA98F", "#DDE5D3"] },
      { name: "WonderSwan", colors: ["#101010", "#404040", "#808080", "#C0C0C0", "#F0F0F0"] },
    ],
  },
  {
    group: "Home Computers",
    palettes: [
      { name: "CGA Mode 4", colors: ["#000000", "#55FFFF", "#FF55FF", "#FFFFFF"] },
      { name: "CGA Mode 5", colors: ["#000000", "#55FFFF", "#FF5555", "#FFFFFF"] },
      {
        name: "EGA 16",
        colors: [
          "#000000", "#0000AA", "#00AA00", "#00AAAA", "#AA0000", "#AA00AA", "#AA5500", "#AAAAAA",
          "#555555", "#5555FF", "#55FF55", "#55FFFF", "#FF5555", "#FF55FF", "#FFFF55", "#FFFFFF",
        ],
      },
      {
        name: "Apple II",
        colors: [
          "#000000", "#6C2940", "#403578", "#D93CF0", "#135740", "#808080", "#2697F0", "#BFB3FF",
          "#404B07", "#D9680F", "#F2F2F2", "#26C400",
        ],
      },
      {
        name: "Commodore 64",
        colors: [
          "#000000", "#FFFFFF", "#880000", "#AAFFEE", "#CC44CC", "#00CC55", "#0000AA", "#EEEE77",
          "#DD8855", "#664400", "#FF7777", "#333333", "#777777", "#AAFF66", "#0088FF", "#BBBBBB",
        ],
      },
      { name: "ZX Spectrum", colors: ["#000000", "#0000D7", "#D70000", "#D700D7", "#00D700", "#00D7D7", "#D7D700", "#D7D7D7"] },
      { name: "MSX", colors: ["#000000", "#3EB849", "#74D07D", "#5955E0", "#8076F1", "#B95E51", "#65DBEF", "#DB6559", "#FF897D", "#CCC35E", "#DED087", "#3AA241", "#B766B5", "#CCCCCC", "#FFFFFF"] },
      { name: "Amstrad CPC", colors: ["#000000", "#000080", "#0000FF", "#800000", "#800080", "#FF0000", "#FF00FF", "#008000", "#008080", "#00FF00", "#00FFFF", "#808000", "#FFFF00", "#FFFFFF"] },
      { name: "Macintosh 1984", colors: ["#000000", "#FFFFFF"] },
      { name: "Atari 2600", colors: ["#000000", "#404040", "#6C6C6C", "#909090", "#B0B0B0", "#C8C8C8", "#DCDCDC", "#ECECEC"] },
      { name: "Teletext", colors: ["#000000", "#FF0000", "#00FF00", "#FFFF00", "#0000FF", "#FF00FF", "#00FFFF", "#FFFFFF"] },
    ],
  },
  {
    group: "Terminals",
    palettes: [
      { name: "Green Phosphor", colors: ["#001100", "#00FF41"] },
      { name: "Green P1", colors: gradient("#03170A", "#4AF626", 5) },
      { name: "Amber Phosphor", colors: ["#1A0F00", "#FFB000"] },
      { name: "Amber P3", colors: gradient("#180D00", "#FFC456", 5) },
      { name: "IBM 5151", colors: ["#0A0F0A", "#2A6B34", "#59C05C", "#B5FF9E"] },
      { name: "Paper White", colors: ["#151515", "#F5F5F5"] },
      { name: "Plasma Orange", colors: ["#180500", "#FF5B00", "#FF9E51", "#FFD9B8"] },
      { name: "VT220", colors: ["#00120B", "#00380F", "#00A11B", "#3FFF6E"] },
      { name: "Cyan CRT", colors: gradient("#001416", "#5EF6FF", 5) },
    ],
  },
  {
    group: "Editor Themes",
    palettes: [
      { name: "Dracula", colors: ["#282A36", "#44475A", "#6272A4", "#8BE9FD", "#50FA7B", "#FFB86C", "#FF79C6", "#BD93F9", "#FF5555", "#F1FA8C", "#F8F8F2"] },
      { name: "Nord", colors: ["#2E3440", "#3B4252", "#434C5E", "#4C566A", "#D8DEE9", "#E5E9F0", "#8FBCBB", "#88C0D0", "#81A1C1", "#5E81AC", "#BF616A", "#D08770", "#EBCB8B", "#A3BE8C", "#B48EAD"] },
      { name: "Solarized Dark", colors: ["#002B36", "#073642", "#586E75", "#657B83", "#839496", "#93A1A1", "#EEE8D5", "#FDF6E3", "#B58900", "#CB4B16", "#DC322F", "#D33682", "#6C71C4", "#268BD2", "#2AA198", "#859900"] },
      { name: "Gruvbox", colors: ["#282828", "#3C3836", "#504945", "#665C54", "#BDAE93", "#D5C4A1", "#EBDBB2", "#FB4934", "#B8BB26", "#FABD2F", "#83A598", "#D3869B", "#8EC07C", "#FE8019"] },
      { name: "Tokyo Night", colors: ["#1A1B26", "#24283B", "#414868", "#565F89", "#7AA2F7", "#7DCFFF", "#BB9AF7", "#9ECE6A", "#E0AF68", "#F7768E", "#C0CAF5"] },
      { name: "Catppuccin Mocha", colors: ["#1E1E2E", "#313244", "#45475A", "#585B70", "#CDD6F4", "#F5E0DC", "#F38BA8", "#FAB387", "#F9E2AF", "#A6E3A1", "#89DCEB", "#89B4FA", "#CBA6F7"] },
      { name: "Rosé Pine", colors: ["#191724", "#1F1D2E", "#26233A", "#6E6A86", "#908CAA", "#E0DEF4", "#EB6F92", "#F6C177", "#EBBCBA", "#31748F", "#9CCFD8", "#C4A7E7"] },
      { name: "Everforest", colors: ["#2D353B", "#343F44", "#475258", "#859289", "#D3C6AA", "#E67E80", "#E69875", "#DBBC7F", "#A7C080", "#83C092", "#7FBBB3", "#D699B6"] },
      { name: "Monokai", colors: ["#272822", "#3E3D32", "#75715E", "#F8F8F2", "#F92672", "#FD971F", "#E6DB74", "#A6E22E", "#66D9EF", "#AE81FF"] },
      { name: "One Dark", colors: ["#282C34", "#3E4451", "#5C6370", "#ABB2BF", "#E06C75", "#D19A66", "#E5C07B", "#98C379", "#56B6C2", "#61AFEF", "#C678DD"] },
    ],
  },
  {
    group: "Pixel Art",
    palettes: [
      { name: "PICO-8", colors: ["#000000", "#1D2B53", "#7E2553", "#008751", "#AB5236", "#5F574F", "#C2C3C7", "#FFF1E8", "#FF004D", "#FFA300", "#FFEC27", "#00E436", "#29ADFF", "#83769C", "#FF77A8", "#FFCCAA"] },
      { name: "Sweetie 16", colors: ["#1A1C2C", "#5D275D", "#B13E53", "#EF7D57", "#FFCD75", "#A7F070", "#38B764", "#257179", "#29366F", "#3B5DC9", "#41A6F6", "#73EFF7", "#F4F4F4", "#94B0C2", "#566C86", "#333C57"] },
      { name: "Dawnbringer 16", colors: ["#140C1C", "#442434", "#30346D", "#4E4A4E", "#854C30", "#346524", "#D04648", "#757161", "#597DCE", "#D27D2C", "#8595A1", "#6DAA2C", "#D2AA99", "#6DC2CA", "#DAD45E", "#DEEED6"] },
      { name: "Nyx8", colors: ["#08141E", "#0F2A3F", "#20394F", "#4E495F", "#816271", "#997577", "#C3A38A", "#F6D6BD"] },
      { name: "Steam Lords", colors: ["#213B25", "#3A604A", "#4F7754", "#A19F7C", "#77744F", "#775C4F", "#603B3A", "#3B2137", "#170F1D", "#2F213B", "#433A60", "#4F5277", "#65738C", "#7C94A1", "#A0B9BA", "#C0D1CC"] },
      { name: "Endesga 16", colors: ["#E4A672", "#B86F50", "#743F39", "#3F2832", "#9E2835", "#E53B44", "#FB922B", "#FFE762", "#63C64D", "#327345", "#193D3F", "#4F6781", "#AFBFD2", "#FFFFFF", "#2CE8F4", "#0484D1"] },
      { name: "Vinik 24", colors: ["#000000", "#6F6776", "#9A9A97", "#C5CCB8", "#8B5580", "#C38890", "#A593A5", "#666092", "#9A4F50", "#C28D75", "#7CA1C0", "#416AA3", "#8D6268", "#BE955C", "#68ADED", "#3C5E8B", "#4B4B4B", "#7B7243", "#A2A947", "#2F3143", "#684A45", "#A46422", "#EBD28B", "#FFFFFF"] },
      { name: "Journey", colors: ["#050914", "#110524", "#3B063A", "#691749", "#9C3247", "#D46453", "#F5A15D", "#FFCF8E", "#FF7A7D", "#FF417D", "#D61A88", "#94007A", "#4F006A", "#000000", "#FFFFFF", "#7D9CB0"] },
      { name: "Slso8", colors: ["#0D2B45", "#203C56", "#544E68", "#8D697A", "#D08159", "#FFAA5E", "#FFD4A3", "#FFECD6"] },
      { name: "Ammo 8", colors: ["#040C06", "#112318", "#1E3A29", "#305D42", "#4D8061", "#89A257", "#BEDC7F", "#EEFFCC"] },
      { name: "Fantasy 16", colors: ["#1F240A", "#39461F", "#544F35", "#6F5C3E", "#8D6B4B", "#A78859", "#C0A57C", "#D3BB9E", "#E9E0BE", "#3B2B21", "#5A3A2C", "#7C4B38", "#9C6249", "#B87C5B", "#D19A75", "#E5B98F"] },
      { name: "Oil 6", colors: ["#FBF5EF", "#F2D3AB", "#C69FA5", "#8B6D9C", "#494D7E", "#272744"] },
    ],
  },
  {
    group: "Duotone",
    palettes: [
      { name: "Cyan / Magenta", colors: ["#00E5FF", "#FF2BD1"] },
      { name: "Sunset", colors: ["#2B0A3D", "#FF7A45"] },
      { name: "Mint", colors: ["#062925", "#8CFFDA"] },
      { name: "Rose", colors: ["#2C0A18", "#FFB3C6"] },
      { name: "Cobalt", colors: ["#03071E", "#4CC9F0"] },
      { name: "Ultraviolet", colors: ["#12002E", "#C77DFF"] },
      { name: "Rust", colors: ["#1B0E05", "#E86A17"] },
      { name: "Forest", colors: ["#04150C", "#6BBF59"] },
      { name: "Slate & Gold", colors: ["#1C2733", "#E8C56B"] },
      { name: "Oxblood", colors: ["#160406", "#B3243A"] },
    ],
  },
  {
    group: "Tritone",
    palettes: [
      { name: "Cold Steel", colors: ["#0B1020", "#4C6A8C", "#DCE7F2"] },
      { name: "Warm Ash", colors: ["#1A1411", "#8A6F5C", "#F0E4D6"] },
      { name: "Acid", colors: ["#101505", "#7CB518", "#EAFF7A"] },
      { name: "Bruise", colors: ["#14060F", "#6A2A5A", "#E6A8D0"] },
      { name: "Ember", colors: ["#0A0503", "#C1440E", "#FFD48A"] },
      { name: "Deep Sea", colors: ["#01161E", "#124559", "#AEC3B0"] },
    ],
  },
  {
    group: "Film & Photo",
    palettes: [
      { name: "Sepia", colors: gradient("#1B1109", "#F5E3C6", 6) },
      { name: "Cyanotype", colors: gradient("#0A1A2F", "#D6E8F5", 6) },
      { name: "Platinum", colors: gradient("#191714", "#EDE7DC", 8) },
      { name: "Selenium", colors: gradient("#120E18", "#E4DEE8", 6) },
      { name: "Kodachrome", colors: ["#1A1614", "#7A2A21", "#C4622C", "#D9A441", "#3F6B45", "#2C4A6E", "#EDE3D2"] },
      { name: "Portra", colors: ["#2B2320", "#7C5A4C", "#B98A72", "#D9B79C", "#EBD5C2", "#F6ECE2"] },
      { name: "Ektachrome", colors: ["#12181F", "#1E4C63", "#3F8FA6", "#C8B58A", "#D9724B", "#F2EDE4"] },
      { name: "Cross Process", colors: ["#04121A", "#125E63", "#5FA85B", "#D9C441", "#E0653C", "#F5E9D0"] },
      { name: "Bleach Bypass", colors: ["#131313", "#4A4E4C", "#8A908C", "#C3C7C2", "#F2F3EF"] },
      { name: "Technicolor", colors: ["#170B10", "#B01F2E", "#E4572E", "#F2C14E", "#3E8E7E", "#1B4D89", "#F5F1E6"] },
    ],
  },
  {
    group: "Print & Riso",
    palettes: [
      { name: "Riso Fluoro Pink", colors: ["#FFFFFF", "#FF48B0", "#1C1C1C"] },
      { name: "Riso Blue / Red", colors: ["#FFF9F0", "#0078BF", "#FF665E", "#2A2A2A"] },
      { name: "Riso Teal / Orange", colors: ["#FBF6EC", "#00838A", "#FF6C2F", "#1A1A1A"] },
      { name: "CMYK", colors: ["#FFFFFF", "#00AEEF", "#EC008C", "#FFF200", "#000000"] },
      { name: "Two-Colour Offset", colors: ["#F3EFE6", "#1F3A5F", "#C8102E"] },
      { name: "Newsprint Halftone", colors: ["#EDE9DF", "#9C978C", "#4A4741", "#141310"] },
      { name: "Zine", colors: ["#FDFBF5", "#FF3B00", "#111111"] },
      { name: "Letterpress", colors: ["#EFE9DA", "#B9AC8F", "#5C5340", "#211D14"] },
    ],
  },
  {
    group: "Neon & Synth",
    palettes: [
      { name: "Synthwave", colors: ["#0D0221", "#261447", "#5F0F40", "#9A031E", "#FB8B24", "#E36414", "#FF206E", "#41EAD4"] },
      { name: "Vaporwave", colors: ["#150E28", "#3C1874", "#7B2CBF", "#FF6AD5", "#C774E8", "#8795E8", "#94D0FF", "#F5F5F5"] },
      { name: "Outrun", colors: ["#0B0033", "#370665", "#7A0BC0", "#FA58B6", "#FF3CAC", "#00F0FF", "#F9F871"] },
      { name: "Cyberpunk", colors: ["#050A0E", "#0ABDC6", "#EA00D9", "#711C91", "#133E7C", "#F5F5F5"] },
      { name: "Miami", colors: ["#1B1035", "#FF4F81", "#FF8FB1", "#2EC4B6", "#FFD166", "#F7F7FF"] },
      { name: "Tokyo Neon", colors: ["#08070D", "#22143A", "#E60073", "#00E5E5", "#FFCC00", "#F0F0F0"] },
      { name: "Blacklight", colors: ["#04010F", "#1B0B5E", "#5B21B6", "#A855F7", "#22D3EE", "#F0ABFC"] },
    ],
  },
  {
    group: "Pastel",
    palettes: [
      { name: "Sorbet", colors: ["#FFF3E6", "#FFD8CC", "#FFC2D1", "#C7E4FF", "#D5F2E3", "#FFF6BF"] },
      { name: "Macaron", colors: ["#FDF6F0", "#F7C8D8", "#CFE1F5", "#D8F0D3", "#FBE8B6", "#D9CBEC"] },
      { name: "Dusty", colors: ["#EFE9E4", "#C9B8AE", "#A8B5A2", "#9BAEC0", "#C0A2AC", "#7C7469"] },
      { name: "Cotton", colors: ["#FFFFFF", "#FFE5EC", "#FFC2D1", "#D0F4DE", "#A9DEF9", "#E4C1F9"] },
      { name: "Muted Retro", colors: ["#F2E8DC", "#D9BBA0", "#B2967D", "#7D8B75", "#5C6B6B", "#3A3E42"] },
      { name: "Sunrise Pastel", colors: ["#2E2244", "#6B4D7A", "#C97B94", "#F1A98B", "#FBD79B", "#FDF3D8"] },
    ],
  },
  {
    group: "Nature",
    palettes: [
      { name: "Autumn", colors: ["#2B1A0F", "#5C2E14", "#A34A1C", "#D9822B", "#E8C468", "#F2E6C9"] },
      { name: "Deep Forest", colors: ["#08110B", "#14301C", "#26542F", "#4B7F45", "#8CB369", "#D6E2B8"] },
      { name: "Ocean", colors: ["#001219", "#005F73", "#0A9396", "#94D2BD", "#E9D8A6", "#EE9B00"] },
      { name: "Desert", colors: ["#2B1B12", "#6B4226", "#B07C4F", "#D9AE7A", "#EBD3A8", "#F7EDDD"] },
      { name: "Arctic", colors: ["#0B1B2B", "#1E3D59", "#4C7A9E", "#9CC4D9", "#D7E9F2", "#FFFFFF"] },
      { name: "Volcanic", colors: ["#0A0A0A", "#2B1B1B", "#6E2314", "#C0391B", "#F27D0C", "#F6D55C"] },
      { name: "Moss & Stone", colors: ["#171A17", "#33392F", "#5A6350", "#8A9179", "#B7B8A8", "#DEDDD0"] },
      { name: "Coral Reef", colors: ["#04202C", "#0B6E7A", "#2CBFB2", "#FF9770", "#FF5E5B", "#FFF6E5"] },
    ],
  },
  {
    group: "Earth & Clay",
    palettes: [
      { name: "Terracotta", colors: ["#2A1710", "#6B3A26", "#A45B3D", "#C98164", "#E3B294", "#F4E2D2"] },
      { name: "Bone", colors: ["#221E1A", "#4E463D", "#877C6C", "#BCB09B", "#E1D8C6", "#F7F2E7"] },
      { name: "Rust & Sage", colors: ["#241C18", "#7A3B21", "#B5613A", "#8B9A7B", "#C3CBB2", "#EDEDE3"] },
      { name: "Adobe", colors: ["#33221B", "#7B4B33", "#B57A52", "#D7A87A", "#EBD1AC", "#F8ECD9"] },
      { name: "Slate & Sand", colors: ["#1E2225", "#3E464C", "#6F7A80", "#A8A290", "#D5C9B1", "#F0E7D6"] },
    ],
  },
  {
    group: "Metals",
    palettes: [
      { name: "Gold", colors: gradient("#2B1B00", "#FFE9A8", 6) },
      { name: "Copper", colors: gradient("#26100A", "#F0B090", 6) },
      { name: "Silver", colors: gradient("#191B1D", "#F0F4F7", 6) },
      { name: "Bronze", colors: gradient("#1E1408", "#D9A566", 5) },
      { name: "Gunmetal", colors: gradient("#0D1013", "#9AA6B0", 5) },
      { name: "Patina", colors: ["#1A1410", "#4A3A28", "#7A6A48", "#4E8878", "#8FCBB5", "#D9EFE4"] },
    ],
  },
  {
    group: "Web Safe",
    palettes: [
      { name: "ANSI 16", colors: ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#C0C0C0", "#808080", "#FF0000", "#00FF00", "#FFFF00", "#0000FF", "#FF00FF", "#00FFFF", "#FFFFFF"] },
      { name: "RGB Primaries", colors: ["#000000", "#FF0000", "#00FF00", "#0000FF", "#FFFFFF"] },
      { name: "RGBCMY", colors: ["#000000", "#FF0000", "#00FF00", "#0000FF", "#00FFFF", "#FF00FF", "#FFFF00", "#FFFFFF"] },
      { name: "Material 8", colors: ["#F44336", "#FF9800", "#FFEB3B", "#4CAF50", "#00BCD4", "#2196F3", "#9C27B0", "#FFFFFF"] },
      { name: "Websafe 27", colors: ["#000000", "#000080", "#0000FF", "#008000", "#008080", "#0080FF", "#00FF00", "#00FF80", "#00FFFF", "#800000", "#800080", "#8000FF", "#808000", "#808080", "#8080FF", "#80FF00", "#80FF80", "#80FFFF", "#FF0000", "#FF0080", "#FF00FF", "#FF8000", "#FF8080", "#FF80FF", "#FFFF00", "#FFFF80", "#FFFFFF"] },
    ],
  },
];

export const ALL_PALETTES: Palette[] = PALETTE_GROUPS.flatMap((g) => g.palettes);

export const DEFAULT_PALETTE = ALL_PALETTES[0];

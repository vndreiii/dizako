# Dizako

A cross-platform dithering app inspired by:
- https://github.com/manoelpiovesan/dither-guy
- https://github.com/makew0rld/didder
- https://github.com/Oslonline/dithering-studio
- https://github.com/robertkist/ditherista/

Goals:
- Material 3 / Expressive UI
- Intuitive controls
- Broad algorithm coverage
- Images + video
- Fast, local-first desktop experience

## Build

```bash
mkdir -p build && cd build
cmake ..
cmake --build .
./dizako
```

## Stack

- C++20
- Qt 6
- QML
- QmlMaterial for Material Design 3

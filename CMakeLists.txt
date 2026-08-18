cmake_minimum_required(VERSION 3.21)
project(Dizako LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)
find_package(Qt6 REQUIRED COMPONENTS Core Gui Quick QuickControls2 Concurrent)
find_package(Threads REQUIRED)

FetchContent_Declare(
  qml_material
  GIT_REPOSITORY https://github.com/hypengw/QmlMaterial.git
  GIT_TAG main
  EXCLUDE_FROM_ALL)
FetchContent_MakeAvailable(qml_material)

qt_standard_project_setup()

qt_add_executable(dizako
    src/main.cpp
    src/core/dither.cpp
)

target_include_directories(dizako PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)

qt_add_qml_module(dizako
    URI App
    VERSION 1.0
    QML_FILES
        qml/Main.qml
        qml/PaletteSelector.qml
        qml/AlgorithmList.qml
)

target_link_libraries(dizako PRIVATE
    Qt6::Core
    Qt6::Gui
    Qt6::Quick
    Qt6::QuickControls2
    qml_material
)


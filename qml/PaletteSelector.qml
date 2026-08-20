import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts

Item {
    id: root
    property var selectedPalette: ["#000000", "#FFFFFF"]
    property string selectedName: "Black & White"

    signal paletteSelected(var colors)

    implicitHeight: 420

    property var presets: [
        { name: "Black & White", colors: ["#000000", "#FFFFFF"] },
        { name: "Grayscale 4", colors: ["#000000", "#555555", "#AAAAAA", "#FFFFFF"] },
        { name: "Grayscale 8", colors: ["#000000", "#242424", "#484848", "#6D6D6D", "#929292", "#B6B6B6", "#DBDBDB", "#FFFFFF"] },
        { name: "Game Boy", colors: ["#0F380F", "#306230", "#8BAC0F", "#9BBC0F"] },
        { name: "CGA", colors: ["#000000", "#55FFFF", "#FF55FF", "#FFFFFF"] },
        { name: "Red / Black", colors: ["#000000", "#FF3B30"] },
        { name: "Nord", colors: ["#2E3440", "#4C566A", "#88C0D0", "#81A1C1", "#E5E9F0"] },
        { name: "Dracula", colors: ["#282A36", "#6272A4", "#8BE9FD", "#50FA7B", "#FFB86C", "#FF79C6", "#BD93F9", "#F8F8F2"] }
    ]

    Pane {
        anchors.fill: parent
        anchors.margins: 12

        ColumnLayout {
            anchors.fill: parent
            spacing: 16

            Label {
                text: "Palette"
                font.pixelSize: 22
                font.bold: true
            }

            Flow {
                Layout.fillWidth: true
                spacing: 8

                Repeater {
                    model: root.selectedPalette
                    delegate: Rectangle {
                        width: 32
                        height: 32
                        radius: 8
                        color: modelData
                        border.color: "#40000000"
                        border.width: 1
                    }
                }
            }

            Label {
                text: "Presets"
                font.pixelSize: 14
                font.bold: true
                color: Material.secondaryTextColor
            }

            ListView {
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true
                spacing: 2
                model: root.presets

                delegate: ItemDelegate {
                    width: ListView.view.width
                    property var preset: modelData
                    highlighted: preset.name === root.selectedName

                    onClicked: {
                        root.selectedName = preset.name
                        root.selectedPalette = preset.colors
                        root.paletteSelected(preset.colors)
                    }

                    contentItem: RowLayout {
                        spacing: 12

                        Row {
                            spacing: 3
                            Repeater {
                                model: preset.colors
                                delegate: Rectangle {
                                    width: 18
                                    height: 18
                                    radius: 9
                                    color: modelData
                                    border.color: "#40000000"
                                    border.width: 1
                                }
                            }
                        }

                        Label {
                            text: preset.name
                            Layout.fillWidth: true
                            elide: Text.ElideRight
                        }
                    }
                }
            }
        }
    }
}

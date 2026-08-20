import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Item {
    id: root
    property var selectedPalette: ["#000000", "#FFFFFF"]
    signal paletteSelected(var colors)

    implicitHeight: 280

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

            RowLayout {
                spacing: 12
                Repeater {
                    model: root.selectedPalette
                    delegate: Rectangle {
                        width: 40
                        height: 40
                        radius: 20
                        color: modelData
                        border.color: "#66000000"
                        border.width: 1
                    }
                }
            }

            Button {
                text: "Use palette"
                onClicked: root.paletteSelected(root.selectedPalette)
            }
        }
    }
}

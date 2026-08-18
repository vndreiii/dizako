import QtQuick
import QtQuick.Layouts
import Qcm.Material as MD

Item {
    id: root
    property var selectedPalette: ["#000000", "#FFFFFF"]

    signal paletteSelected(var colors)

    implicitHeight: 280

    MD.Card {
        anchors.fill: parent
        anchors.margins: 12

        MD.CardContent {
            anchors.fill: parent
            ColumnLayout {
                anchors.fill: parent
                spacing: 16

                MD.Text {
                    text: "Palette"
                    font.pixelSize: 22
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
                            border.color: MD.Color.outline
                            border.width: 1
                        }
                    }
                }

                MD.Button {
                    text: "Use palette"
                    onClicked: root.paletteSelected(root.selectedPalette)
                }
            }
        }
    }
}

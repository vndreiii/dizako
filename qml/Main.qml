import QtQuick
import QtQuick.Layouts
import QtQuick.Templates as T
import Qcm.Material as MD

T.ApplicationWindow {
    id: window
    width: 1280
    height: 800
    visible: true
    title: "Dizako"

    MD.Theme {
        id: theme
        color: MD.Color.primary
    }

    MD.Container {
        anchors.fill: parent

        ColumnLayout {
            anchors.fill: parent
            spacing: 0

            MD.AppBar {
                id: appBar
                Layout.fillWidth: true
                title: "Dizako"
                Layout.preferredHeight: 64

                MD.Button {
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.left: parent.left
                    anchors.leftMargin: 16
                    text: "Open"
                    onClicked: console.log("Open image")
                }

                MD.Button {
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.right: parent.right
                    anchors.rightMargin: 16
                    text: "Export"
                    onClicked: console.log("Export result")
                }
            }

            RowLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: 16
                padding: 16

                PaletteSelector {
                    Layout.preferredWidth: 260
                    Layout.fillHeight: true
                }

                AlgorithmList {
                    Layout.preferredWidth: 260
                    Layout.fillHeight: true
                }

                MD.Card {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    MD.CardContent {
                        anchors.fill: parent
                        MD.Text {
                            anchors.centerIn: parent
                            text: "Preview area"
                            color: MD.Color.onSurface
                            font.pixelSize: 20
                        }
                    }
                }
            }
        }
    }
}

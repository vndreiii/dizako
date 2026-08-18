import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Dialogs
import Qcm.Material as MD

import App

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
                    onClicked: fileDialog.open()
                }

                MD.Button {
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.right: parent.right
                    anchors.rightMargin: 16
                    text: "Export"
                    enabled: imagePreview.source !== ""
                    onClicked: exportDialog.open()
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
                    onPaletteSelected: ditherEngine.setPalette(palette)
                }

                AlgorithmList {
                    Layout.preferredWidth: 260
                    Layout.fillHeight: true
                    onAlgorithmSelected: {
                        selectedAlg = algorithm
                        applyDither()
                    }
                }

                MD.Card {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true

                    MD.CardContent {
                        anchors.fill: parent
                        Flickable {
                            anchors.fill: parent
                            contentWidth: imagePreview.width
                            contentHeight: imagePreview.height
                            clip: true

                            Image {
                                id: imagePreview
                                source: ""
                                cache: false
                                smooth: true
                                fillMode: Image.PreserveAspectFit
                                anchors.centerIn: parent
                                width: Math.min(parent.width, naturalWidth)
                                height: Math.min(parent.height, naturalHeight)

                                onStatusChanged: {
                                    if (status === Image.Ready) {
                                        ditherEngine.setSourcePath(source);
                                        statusLabel.text = "";
                                    } else if (status === Image.Error) {
                                        statusLabel.text = "Failed to load image";
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    FileDialog {
        id: fileDialog
        title: "Open Image"
        nameFilters: ["Image files (*.png *.jpg *.jpeg *.bmp *.gif *.tiff *.webp)"]
        onAccepted: {
            imagePreview.source = selectedFile;
        }
    }

    FileDialog {
        id: exportDialog
        title: "Export Image"
        fileMode: FileDialog.SaveFile
        defaultSuffix: ".png"
        nameFilters: ["PNG files (*.png)", "JPEG files (*.jpg)", "WebP files (*.webp)"]
        onAccepted: {
            if (ditherEngine.resultPath().length && selectedFile.length) {
                const src = ditherEngine.resultPath();
                const dst = selectedFile;
                const ok = Qt.copy(src, dst);
                statusLabel.text = ok ? "Exported" : "Export failed";
            }
        }
    }

    property string selectedAlg: "FloydSteinberg"

    function applyDither() {
        if (imagePreview.source === "")
            return;
        const result = ditherEngine.applyDither(selectedAlg);
        if (result.length)
            imagePreview.source = result;
    }

    Text {
        id: statusLabel
        anchors.bottom: parent.bottom
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottomMargin: 16
        text: ""
        color: MD.Color.onSurfaceVariant
        font.pixelSize: 14
    }
}

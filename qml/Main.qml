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
                    enabled: ditherEngine.processing ? false : (imagePreview.source !== "" && ditherEngine.resultPath().length > 0)
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
                    Layout.preferredWidth: 280
                    Layout.fillHeight: true
                }

                MD.Card {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true

                    MD.CardContent {
                        anchors.fill: parent
                        Flickable {
                            id: flick
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

                                Drag.active: dragArea.drag.active
                                Drag.supportedActions: Qt.CopyAction
                                Drag.mimeData: {
                                    return { "text/uri-list": source }
                                }
                                Drag.onActiveChanged: {
                                    if (!Drag.active && Drag.target === null && source !== "")
                                        ditherEngine.setSourcePath(source);
                                }

                                MouseArea {
                                    id: dragArea
                                    anchors.fill: parent
                                    drag.target: parent
                                    onPressed: {
                                        if (imagePreview.source !== "")
                                            dragArea.drag.start();
                                    }
                                }

                                onStatusChanged: {
                                    if (status === Image.Ready) {
                                        if (!ditherEngine.sourcePath || ditherEngine.sourcePath !== source)
                                            ditherEngine.setSourcePath(source);
                                        statusLabel.text = "";
                                    } else if (status === Image.Error) {
                                        statusLabel.text = "Failed to load image";
                                    }
                                }
                            }
                        }

                        DropArea {
                            anchors.fill: parent
                            onDropped: {
                                if (drop.urls.length > 0) {
                                    const url = drop.urls[0];
                                    imagePreview.source = url.toLocalFile();
                                    statusLabel.text = "";
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
            statusLabel.text = "";
        }
    }

    FileDialog {
        id: exportDialog
        title: "Export Image"
        fileMode: FileDialog.SaveFile
        defaultSuffix: ".png"
        nameFilters: ["PNG files (*.png)", "JPEG files (*.jpg)", "WebP files (*.webp)"]
        onAccepted: {
            if (selectedFile.length) {
                const ok = ditherEngine.exportResult(selectedFile);
                statusLabel.text = ok ? "Exported" : "Export failed";
            }
        }
    }

    Connections {
        target: ditherEngine
        function onResultPathChanged(path) {
            if (path.length && imagePreview.source !== path) {
                imagePreview.source = path;
                statusLabel.text = ditherEngine.processing ? "Processing..." : "";
            }
        }
        function onProcessingChanged(processing) {
            statusLabel.text = processing ? "Processing..." : "";
            appBar.enabled = !processing;
        }
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

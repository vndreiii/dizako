import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Dialogs
import QtQuick.Controls.Material

import App

ApplicationWindow {
    id: window
    width: 1280
    height: 800
    minimumWidth: 960
    minimumHeight: 640
    visible: true
    title: "Dizako"

    Material.theme: Material.Theme.Light
    Material.accent: Material.Blue

    function loadImage(fileUrl) {
        if (!fileUrl || String(fileUrl).length === 0)
            return
        imagePreview.source = fileUrl
        ditherEngine.setSourceUrl(fileUrl)
        statusLabel.text = ""
    }

    header: ToolBar {
        id: appBar
        implicitHeight: 64

        RowLayout {
            anchors.fill: parent
            anchors.leftMargin: 16
            anchors.rightMargin: 16
            spacing: 12

            Label {
                text: "Dizako"
                font.pixelSize: 20
                font.bold: true
                Layout.alignment: Qt.AlignVCenter
            }

            Item { Layout.fillWidth: true }

            Button {
                text: "Open"
                Layout.alignment: Qt.AlignVCenter
                onClicked: fileDialog.open()
            }

            Button {
                text: "Export"
                highlighted: true
                Layout.alignment: Qt.AlignVCenter
                enabled: !ditherEngine.processing && ditherEngine.resultPath.length > 0
                onClicked: exportDialog.open()
            }
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 16

        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 16

            PaletteSelector {
                Layout.preferredWidth: 240
                Layout.fillHeight: true
                onPaletteSelected: ditherEngine.setPaletteColors(palette)
            }

            AlgorithmList {
                Layout.preferredWidth: 280
                Layout.fillHeight: true
            }

            Pane {
                Layout.fillWidth: true
                Layout.fillHeight: true
                padding: 0
                clip: true

                Flickable {
                    id: flick
                    anchors.fill: parent
                    contentWidth: Math.max(width, imagePreview.width)
                    contentHeight: Math.max(height, imagePreview.height)
                    clip: true
                    boundsBehavior: Flickable.StopAtBounds

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
                            if (status === Image.Error)
                                statusLabel.text = "Failed to load image"
                            else if (status === Image.Ready)
                                statusLabel.text = ""
                        }
                    }

                    Item {
                        id: emptyState
                        anchors.fill: parent
                        visible: imagePreview.source == ""

                        Label {
                            anchors.centerIn: parent
                            text: "Drop an image here\nor click Open"
                            horizontalAlignment: Text.AlignHCenter
                            color: Material.secondaryTextColor
                            font.pixelSize: 18
                            lineHeight: 1.4
                        }
                    }

                    DropArea {
                        id: dropArea
                        anchors.fill: parent
                        onEntered: emptyState.opacity = 0.6
                        onExited: emptyState.opacity = 1.0
                        onDropped: {
                            if (drop.urls.length > 0)
                                loadImage(drop.urls[0])
                        }
                    }
                }

                BusyIndicator {
                    anchors.centerIn: parent
                    running: ditherEngine.processing
                }

                Label {
                    id: statusLabel
                    anchors.bottom: parent.bottom
                    anchors.horizontalCenter: parent.horizontalCenter
                    anchors.bottomMargin: 12
                    text: ""
                    color: Material.secondaryTextColor
                    font.pixelSize: 14
                }
            }
        }
    }

    FileDialog {
        id: fileDialog
        title: "Open Image"
        nameFilters: ["Image files (*.png *.jpg *.jpeg *.bmp *.gif *.tiff *.webp)"]
        onAccepted: loadImage(selectedFile)
    }

    FileDialog {
        id: exportDialog
        title: "Export Image"
        fileMode: FileDialog.SaveFile
        defaultSuffix: ".png"
        nameFilters: ["PNG files (*.png)", "JPEG files (*.jpg)", "WebP files (*.webp)"]
        onAccepted: {
            if (String(selectedFile).length) {
                const ok = ditherEngine.exportResult(ditherEngine.localPathFromUrl(selectedFile))
                statusLabel.text = ok ? "Exported" : "Export failed"
            }
        }
    }

    Connections {
        target: ditherEngine
        function onResultPathChanged(path) {
            if (path.length) {
                imagePreview.source = path
                statusLabel.text = ""
            }
        }
        function onProcessingChanged(processing) {
            statusLabel.text = processing ? "Processing..." : ""
            appBar.enabled = !processing
        }
    }
}

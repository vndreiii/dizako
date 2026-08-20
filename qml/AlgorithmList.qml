import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Item {
    id: root
    property string selectedAlgorithm: "FloydSteinberg"
    property bool serpentine: false
    property int bayerSize: 4
    property int threshold: 128
    property bool invert: false
    property bool grayscale: false
    property real strength: 100

    signal algorithmSelected(string name)
    signal settingsChanged()

    implicitHeight: 420

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 12
        spacing: 12

        Label {
            text: "Algorithm"
            font.pixelSize: 20
            font.bold: true
        }

        ListView {
            Layout.fillWidth: true
            Layout.preferredHeight: 180
            model: [
                "FloydSteinberg", "FalseFloydSteinberg", "Atkinson", "JarvisJudiceNinke",
                "Stucki", "Burkes", "Sierra", "Sierra2", "Sierra2-4A", "SierraLite",
                "StevensonArce", "Bayer", "BinaryThreshold", "RandomNoise"
            ]
            clip: true
            delegate: ItemDelegate {
                width: ListView.view.width
                text: modelData
                highlighted: root.selectedAlgorithm === modelData
                onClicked: {
                    root.selectedAlgorithm = modelData
                    root.algorithmSelected(modelData)
                    ditherEngine.setAlgorithm(modelData)
                }
            }
        }

        Label {
            text: "Settings"
            font.pixelSize: 20
            font.bold: true
        }

        GridLayout {
            columns: 2
            rowSpacing: 10
            columnSpacing: 16

            Label { text: "Strength" }
            Slider {
                Layout.fillWidth: true
                from: 0; to: 100; value: root.strength
                onValueChanged: {
                    root.strength = value
                    ditherEngine.setStrength(value)
                    root.settingsChanged()
                }
            }

            Label { text: "Bayer size" }
            ComboBox {
                Layout.fillWidth: true
                model: [2, 4, 8, 16, 32]
                currentIndex: model.indexOf(ditherEngine.bayerSize)
                onCurrentIndexChanged: {
                    if (currentIndex >= 0 && currentIndex < model.length) {
                        ditherEngine.setBayerSize(model[currentIndex])
                        root.settingsChanged()
                    }
                }
            }

            Label { text: "Threshold" }
            Slider {
                Layout.fillWidth: true
                from: 0; to: 255; value: ditherEngine.threshold
                onValueChanged: {
                    ditherEngine.setThreshold(Math.round(value))
                    root.settingsChanged()
                }
            }

            Item { Layout.fillWidth: true; Layout.preferredHeight: 1 }

            RowLayout {
                Layout.fillWidth: true
                spacing: 12

                CheckBox {
                    checked: root.serpentine
                    onToggled: {
                        root.serpentine = checked
                        ditherEngine.setSerpentine(checked)
                        root.settingsChanged()
                    }
                }
                Label { text: "Serpentine" }
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 12

                CheckBox {
                    checked: root.invert
                    onToggled: {
                        root.invert = checked
                        ditherEngine.setInvert(checked)
                        root.settingsChanged()
                    }
                }
                Label { text: "Invert" }
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 12

                CheckBox {
                    checked: root.grayscale
                    onToggled: {
                        root.grayscale = checked
                        ditherEngine.setGrayscale(checked)
                        root.settingsChanged()
                    }
                }
                Label { text: "Grayscale source" }
            }
        }
    }
}

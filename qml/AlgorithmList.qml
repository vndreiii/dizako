import QtQuick
import QtQuick.Layouts
import Qcm.Material as MD

Item {
    id: root
    property string selectedAlgorithm: "FloydSteinberg"

    signal algorithmSelected(string name)

    implicitHeight: 360

    MD.Card {
        anchors.fill: parent
        anchors.margins: 12

        MD.CardContent {
            anchors.fill: parent
            ColumnLayout {
                anchors.fill: parent
                spacing: 16

                MD.Text {
                    text: "Algorithm"
                    font.pixelSize: 22
                }

                ListView {
                    Layout.fillHeight: true
                    model: ["FloydSteinberg", "Atkinson", "Bayer", "Stucki", "JarvisJudiceNinke"]
                    clip: true
                    delegate: T.ItemDelegate {
                        width: ListView.view.width
                        text: modelData
                        highlighted: root.selectedAlgorithm === modelData
                        onClicked: {
                            root.selectedAlgorithm = modelData
                            root.algorithmSelected(modelData)
                        }
                    }
                }
            }
        }
    }
}

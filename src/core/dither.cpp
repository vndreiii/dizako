#include "core/dither.h"
#include <QFile>
#include <QStandardPaths>

namespace Dizako {

DitherEngine::DitherEngine(QObject *parent)
    : QObject(parent)
{
}

QList<QColor> DitherEngine::palette() const
{
    return m_palette;
}

void DitherEngine::setPalette(const QList<QColor> &palette)
{
    if (m_palette == palette)
        return;
    m_palette = palette;
    emit paletteChanged(m_palette);
}

QString DitherEngine::sourcePath() const
{
    return m_sourcePath;
}

void DitherEngine::setSourcePath(const QString &path)
{
    if (m_sourcePath == path)
        return;
    m_sourcePath = path;
    emit sourcePathChanged(m_sourcePath);
}

QString DitherEngine::resultPath() const
{
    return m_resultPath;
}

QImage DitherEngine::loadImage(const QString &path) const
{
    return QImage(path);
}

QString DitherEngine::saveImage(const QImage &image) const
{
    const QString dir = QStandardPaths::writableLocation(QStandardPaths::TempLocation);
    const QString path = dir + QDir::separator() + "dizako_result_" +
                         QString::number(QDateTime::currentMSecsSinceEpoch()) + ".png";
    if (image.save(path))
        return path;
    return {};
}

QImage DitherEngine::applyDither(const QImage &image, const QString &algorithm)
{
    QImage result = image.convertToFormat(QImage.Format_ARGB32_Premultiplied);
    Q_UNUSED(algorithm);
    return result;
}

QString DitherEngine::applyDither(const QString &algorithm)
{
    if (m_sourcePath.isEmpty())
        return {};

    QImage image = loadImage(m_sourcePath);
    if (image.isNull())
        return {};

    QImage output = applyDither(image, algorithm);
    const QString path = saveImage(output);
    if (path.isEmpty())
        return {};

    if (m_resultPath != path) {
        m_resultPath = path;
        emit resultPathChanged(m_resultPath);
    }
    return m_resultPath;
}

bool DitherEngine::exportResult(const QString &destination)
{
    if (m_resultPath.isEmpty())
        return false;
    return QFile::copy(m_resultPath, destination);
}

}

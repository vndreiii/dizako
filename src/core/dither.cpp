#include "core/dither.h"

namespace Dizako {

DitherEngine::DitherEngine(QObject *parent)
    : QObject(parent)
{
}

void DitherEngine::setPalette(const QList<QColor> &palette)
{
    m_palette = palette;
    emit paletteChanged(m_palette);
}

QList<QColor> DitherEngine::palette() const
{
    return m_palette;
}

QImage DitherEngine::applyDither(const QImage &image, const QString &algorithm)
{
    Q_UNUSED(image);
    Q_UNUSED(algorithm);
    return image;
}

}

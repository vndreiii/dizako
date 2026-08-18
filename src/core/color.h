#ifndef COLOR_H
#define COLOR_H

#include <QImage>
#include <QColor>
#include <QList>
#include <cmath>
#include <limits>

namespace Dizako::Color {

inline float srgbToLinear(float v)
{
    if (v <= 0.04045f)
        return v / 12.92f;
    return std::pow((v + 0.055f) / 1.055f, 2.4f);
}

inline float linearToSrgb(float v)
{
    if (v <= 0.0031308f)
        return v * 12.92f;
    return 1.055f * std::pow(v, 1.0f / 2.4f) - 0.055f;
}

inline float luminance(const QColor &c)
{
    const float r = srgbToLinear(c.redF());
    const float g = srgbToLinear(c.greenF());
    const float b = srgbToLinear(c.blueF());
    return 0.2126f * r + 0.7152f * g + 0.0722f * b;
}

inline float colorDistance(const QColor &a, const QColor &b)
{
    const float dr = a.redF() - b.redF();
    const float dg = a.greenF() - b.greenF();
    const float db = a.blueF() - b.blueF();
    return std::sqrt(dr * dr + dg * dg + db * db);
}

inline QColor findClosest(const QColor &color, const QList<QColor> &palette)
{
    if (palette.isEmpty())
        return color;
    float best = std::numeric_limits<float>::max();
    QColor result = palette.first();
    for (const QColor &p : palette) {
        const float d = colorDistance(color, p);
        if (d < best) {
            best = d;
            result = p;
        }
    }
    return result;
}

inline QImage toLinear(const QImage &src)
{
    if (src.format() != QImage::Format_ARGB32_Premultiplied)
        return src.convertToFormat(QImage::Format_ARGB32_Premultiplied);

    QImage out(src.size(), QImage::Format_ARGB32_Premultiplied);
    for (int y = 0; y < src.height(); ++y) {
        const QRgb *srcLine = reinterpret_cast<const QRgb*>(src.scanLine(y));
        QRgb *dstLine = reinterpret_cast<QRgb*>(out.scanLine(y));
        for (int x = 0; x < src.width(); ++x) {
            const QRgb s = srcLine[x];
            const float r = srgbToLinear(qRed(s) / 255.0f);
            const float g = srgbToLinear(qGreen(s) / 255.0f);
            const float b = srgbToLinear(qBlue(s) / 255.0f);
            dstLine[x] = qRgba(
                qRound(r * 255),
                qRound(g * 255),
                qRound(b * 255),
                qAlpha(s)
            );
        }
    }
    return out;
}

inline QImage toSrgb(const QImage &src)
{
    if (src.format() != QImage::Format_ARGB32_Premultiplied)
        return src.convertToFormat(QImage::Format_ARGB32_Premultiplied);

    QImage out(src.size(), QImage::Format_ARGB32_Premultiplied);
    for (int y = 0; y < src.height(); ++y) {
        const QRgb *srcLine = reinterpret_cast<const QRgb*>(src.scanLine(y));
        QRgb *dstLine = reinterpret_cast<QRgb*>(out.scanLine(y));
        for (int x = 0; x < src.width(); ++x) {
            const QRgb s = srcLine[x];
            const float r = linearToSrgb(qRed(s) / 255.0f);
            const float g = linearToSrgb(qGreen(s) / 255.0f);
            const float b = linearToSrgb(qBlue(s) / 255.0f);
            dstLine[x] = qRgba(
                qBound(0, qRound(r * 255), 255),
                qBound(0, qRound(g * 255), 255),
                qBound(0, qRound(b * 255), 255),
                qAlpha(s)
            );
        }
    }
    return out;
}

inline QImage quantizeToPalette(const QImage &linear, const QList<QColor> &palette)
{
    if (palette.isEmpty())
        return linear;

    QImage out(linear.size(), QImage::Format_ARGB32_Premultiplied);
    for (int y = 0; y < linear.height(); ++y) {
        const QRgb *srcLine = reinterpret_cast<const QRgb*>(linear.scanLine(y));
        QRgb *dstLine = reinterpret_cast<QRgb*>(out.scanLine(y));
        for (int x = 0; x < linear.width(); ++x) {
            const QRgb s = srcLine[x];
            const QColor c(s);
            const QColor closest = findClosest(c, palette);
            dstLine[x] = closest.rgba();
        }
    }
    return out;
}

}

#endif

#ifndef QUANT_H
#define QUANT_H

#include <QImage>
#include <QColor>
#include <QList>

namespace Dizako::Quant {

inline QImage kMeans(const QImage &image, int k, int iterations = 5)
{
    if (k <= 0)
        return image;

    QImage out(image.size(), QImage::Format_ARGB32_Premultiplied);
    QList<QColor> centers;

    // init by sampling pixels
    for (int i = 0; i < k; ++i) {
        const int x = (i * image.width()) / k;
        const int y = (i * image.height()) / k;
        centers.append(QColor(image.pixel(x % image.width(), y % image.height())));
    }

    for (int iter = 0; iter < iterations; ++iter) {
        QList<QList<QColor>> buckets(k);
        for (int y = 0; y < image.height(); ++y) {
            const QRgb *line = reinterpret_cast<const QRgb*>(image.scanLine(y));
            for (int x = 0; x < image.width(); ++x) {
                const QColor px(line[x]);
                int best = 0;
                float bestD = std::numeric_limits<float>::max();
                for (int i = 0; i < k; ++i) {
                    const float d = Color::colorDistance(px, centers[i]);
                    if (d < bestD) {
                        bestD = d;
                        best = i;
                    }
                }
                buckets[best].append(px);
            }
        }

        for (int i = 0; i < k; ++i) {
            if (buckets[i].isEmpty())
                continue;
            float r = 0, g = 0, b = 0;
            for (const QColor &c : buckets[i]) {
                r += c.redF();
                g += c.greenF();
                b += c.blueF();
            }
            centers[i] = QColor::fromRgbF(
                r / buckets[i].size(),
                g / buckets[i].size(),
                b / buckets[i].size()
            );
        }
    }

    for (int y = 0; y < image.height(); ++y) {
        const QRgb *line = reinterpret_cast<const QRgb*>(image.scanLine(y));
        QRgb *dstLine = reinterpret_cast<QRgb*>(out.scanLine(y));
        for (int x = 0; x < image.width(); ++x) {
            const QColor px(line[x]);
            int best = 0;
            float bestD = std::numeric_limits<float>::max();
            for (int i = 0; i < k; ++i) {
                const float d = Color::colorDistance(px, centers[i]);
                if (d < bestD) {
                    bestD = d;
                    best = i;
                }
            }
            dstLine[x] = centers[best].rgba();
        }
    }
    return out;
}

}

#endif

#ifndef ALGORITHMS_H
#define ALGORITHMS_H

#include <QImage>
#include <QColor>
#include <QList>
#include <QString>
#include <QRgb>
#include <QMutex>
#include <QFutureWatcher>
#include <QtConcurrent/qtconcurrentrun.h>
#include <QRandomGenerator>
#include <algorithm>
#include <limits>
#include "color.h"

namespace Dizako::Algorithms {

using Palette = QList<QColor>;

struct RunContext {
    QString sourcePath;
    QImage working;
    QImage preview;
    Palette palette;
    QString algorithm;
    float strength = 100.0f;
    bool serpentine = false;
    int bayerSize = 4;
    int threshold = 128;
    bool invert = false;
    bool grayscale = false;
    bool running = false;
    bool canceled = false;
    mutable QMutex mutex;
};

inline void applyBrightnessContrastGamma(QImage &img, float brightness, float contrast, float gamma)
{
    if (img.format() != QImage::Format_ARGB32_Premultiplied)
        img = img.convertToFormat(QImage::Format_ARGB32_Premultiplied);
    const float b = brightness / 255.0f;
    const float c = (contrast / 100.0f) * 2.0f;
    const float g = 1.0f / (gamma > 0.001f ? gamma : 0.001f);

    for (int y = 0; y < img.height(); ++y) {
        QRgb *line = reinterpret_cast<QRgb*>(img.scanLine(y));
        for (int x = 0; x < img.width(); ++x) {
            QRgb px = line[x];
            float r = qRed(px) / 255.0f;
            float gv = qGreen(px) / 255.0f;
            float bv = qBlue(px) / 255.0f;

            r = ((r - 0.5f) * c + 0.5f) + b;
            gv = ((gv - 0.5f) * c + 0.5f) + b;
            bv = ((bv - 0.5f) * c + 0.5f) + b;

            r = std::pow(std::clamp(r, 0.0f, 1.0f), g);
            gv = std::pow(std::clamp(gv, 0.0f, 1.0f), g);
            bv = std::pow(std::clamp(bv, 0.0f, 1.0f), g);

            line[x] = qRgba(qBound(0, qRound(r * 255), 255),
                            qBound(0, qRound(gv * 255), 255),
                            qBound(0, qRound(bv * 255), 255),
                            qAlpha(px));
        }
    }
}

inline QImage prepareWorking(const QImage &source, const Palette &palette, bool grayscale)
{
    QImage work = source;
    if (work.format() != QImage::Format_ARGB32_Premultiplied)
        work = work.convertToFormat(QImage::Format_ARGB32_Premultiplied);

    applyBrightnessContrastGamma(work, 0, 100, 1);

    if (grayscale || !palette.isEmpty()) {
        work = Color::toLinear(work);
        if (!palette.isEmpty())
            work = Color::quantizeToPalette(work, palette);
        else
            work = Color::quantizeToPalette(work, {Qt::black, Qt::white});
        work = Color::toSrgb(work);
    }
    return work;
}

inline float getStrengthMultiplier(float strength)
{
    return std::clamp(strength / 100.0f, 0.0f, 1.0f);
}

inline void applyThreshold(QImage &img, int threshold)
{
    for (int y = 0; y < img.height(); ++y) {
        QRgb *line = reinterpret_cast<QRgb*>(img.scanLine(y));
        for (int x = 0; x < img.width(); ++x) {
            const QRgb px = line[x];
            const float v = Color::luminance(QColor(px));
            const int out = v < (threshold / 255.0f) ? 0 : 255;
            line[x] = qRgba(out, out, out, qAlpha(px));
        }
    }
}

inline void applyInvert(QImage &img)
{
    for (int y = 0; y < img.height(); ++y) {
        QRgb *line = reinterpret_cast<QRgb*>(img.scanLine(y));
        for (int x = 0; x < img.width(); ++x) {
            const QRgb px = line[x];
            line[x] = qRgba(255 - qRed(px), 255 - qGreen(px), 255 - qBlue(px), qAlpha(px));
        }
    }
}

inline void binaryThreshold(QImage &img, int threshold)
{
    for (int y = 0; y < img.height(); ++y) {
        QRgb *line = reinterpret_cast<QRgb*>(img.scanLine(y));
        for (int x = 0; x < img.width(); ++x) {
            const QRgb px = line[x];
            const float v = Color::luminance(QColor(px));
            const int out = v < (threshold / 255.0f) ? 0 : 255;
            line[x] = qRgba(out, out, out, qAlpha(px));
        }
    }
}

inline void randomNoise(QImage &img)
{
    for (int y = 0; y < img.height(); ++y) {
        QRgb *line = reinterpret_cast<QRgb*>(img.scanLine(y));
        for (int x = 0; x < img.width(); ++x) {
            const int n = QRandomGenerator::global()->bounded(256);
            line[x] = qRgba(n, n, n, qAlpha(line[x]));
        }
    }
}

inline QImage bayerMatrix(int size)
{
    QImage m(1, 1, QImage::Format_ARGB32_Premultiplied);
    m.setPixel(0, 0, qRgba(0, 0, 0, 255));
    if (size <= 1)
        return m;

    QImage result(size, size, QImage::Format_ARGB32);
    for (int y = 0; y < size; ++y) {
        for (int x = 0; x < size; ++x) {
            const int v = ((x ^ y) == 0) ? 0 : 255;
            result.setPixel(x, y, v);
        }
    }
    return result;
}

inline void orderedBayer(QImage &img, int size, float strength)
{
    const QImage matrix = bayerMatrix(size);
    const int w = img.width();
    const int h = img.height();
    const float multiplier = getStrengthMultiplier(strength);

    for (int y = 0; y < h; ++y) {
        QRgb *line = reinterpret_cast<QRgb*>(img.scanLine(y));
        for (int x = 0; x < w; ++x) {
            const float v = Color::luminance(QColor(line[x]));
            const int mx = x % size;
            const int my = y % size;
            const float threshold = ((qRed(matrix.pixel(mx, my)) / 255.0f) * multiplier) +
                                    ((1.0f - multiplier) * 0.5f);
            const int out = v < threshold ? 0 : 255;
            line[x] = qRgba(out, out, out, qAlpha(line[x]));
        }
    }
}

inline void atkinson(QImage &img, bool serpentine)
{
    const int w = img.width();
    const int h = img.height();
    QImage work = img;

    for (int y = 0; y < h; ++y) {
        const bool leftToRight = serpentine ? (y % 2 == 0) : true;
        const int startX = leftToRight ? 0 : w - 1;
        const int endX = leftToRight ? w : -1;
        const int dx = leftToRight ? 1 : -1;

        for (int x = startX; x != endX; x += dx) {
            const QRgb oldPx = work.pixel(x, y);
            const QColor old(oldPx);
            const QColor newC = Color::findClosest(old, {Qt::black, Qt::white});
            work.setPixel(x, y, newC.rgba());

            const float errR = old.redF() - newC.redF();
            const float errG = old.greenF() - newC.greenF();
            const float errB = old.blueF() - newC.blueF();

            const auto addError = [&](int nx, int ny, float factor) {
                if (nx < 0 || ny < 0 || nx >= w || ny >= h)
                    return;
                QRgb px = work.pixel(nx, ny);
                QColor c(px);
                c.setRedF(std::clamp(c.redF() + errR * factor, 0.0f, 1.0f));
                c.setGreenF(std::clamp(c.greenF() + errG * factor, 0.0f, 1.0f));
                c.setBlueF(std::clamp(c.blueF() + errB * factor, 0.0f, 1.0f));
                work.setPixel(nx, ny, c.rgba());
            };

            addError(x + dx, y, 1.0f / 8.0f);
            addError(x + dx, y - 1, 1.0f / 8.0f);
            addError(x, y + 1, 1.0f / 8.0f);
            addError(x + 2 * dx, y, 1.0f / 8.0f);
            addError(x - dx, y + 1, 1.0f / 8.0f);
            addError(x, y + 2, 1.0f / 8.0f);
        }
    }

    img = work;
}

inline void floydSteinberg(QImage &img, bool serpentine)
{
    const int w = img.width();
    const int h = img.height();
    QImage work = img;

    for (int y = 0; y < h; ++y) {
        const bool leftToRight = serpentine ? (y % 2 == 0) : true;
        const int startX = leftToRight ? 0 : w - 1;
        const int endX = leftToRight ? w : -1;
        const int dx = leftToRight ? 1 : -1;

        for (int x = startX; x != endX; x += dx) {
            const QRgb oldPx = work.pixel(x, y);
            const QColor old(oldPx);
            const QColor newC = Color::findClosest(old, {Qt::black, Qt::white});
            work.setPixel(x, y, newC.rgba());

            const float errR = old.redF() - newC.redF();
            const float errG = old.greenF() - newC.greenF();
            const float errB = old.blueF() - newC.blueF();

            const auto addError = [&](int nx, int ny, float factor) {
                if (nx < 0 || ny < 0 || nx >= w || ny >= h)
                    return;
                QRgb px = work.pixel(nx, ny);
                QColor c(px);
                c.setRedF(std::clamp(c.redF() + errR * factor, 0.0f, 1.0f));
                c.setGreenF(std::clamp(c.greenF() + errG * factor, 0.0f, 1.0f));
                c.setBlueF(std::clamp(c.blueF() + errB * factor, 0.0f, 1.0f));
                work.setPixel(nx, ny, c.rgba());
            };

            addError(x + dx, y, 7.0f / 16.0f);
            addError(x - dx, y + 1, 3.0f / 16.0f);
            addError(x, y + 1, 5.0f / 16.0f);
            addError(x + dx, y + 1, 1.0f / 16.0f);
        }
    }

    img = work;
}

inline void jarvisJudiceNinke(QImage &img, bool serpentine)
{
    const int w = img.width();
    const int h = img.height();
    QImage work = img;

    for (int y = 0; y < h; ++y) {
        const bool leftToRight = serpentine ? (y % 2 == 0) : true;
        const int startX = leftToRight ? 0 : w - 1;
        const int endX = leftToRight ? w : -1;
        const int dx = leftToRight ? 1 : -1;

        for (int x = startX; x != endX; x += dx) {
            const QColor old(work.pixel(x, y));
            const QColor newC = Color::findClosest(old, {Qt::black, Qt::white});
            work.setPixel(x, y, newC.rgba());

            const float errR = old.redF() - newC.redF();
            const float errG = old.greenF() - newC.greenF();
            const float errB = old.blueF() - newC.blueF();

            const auto addError = [&](int nx, int ny, float factor) {
                if (nx < 0 || ny < 0 || nx >= w || ny >= h)
                    return;
                QColor c(work.pixel(nx, ny));
                c.setRedF(std::clamp(c.redF() + errR * factor, 0.0f, 1.0f));
                c.setGreenF(std::clamp(c.greenF() + errG * factor, 0.0f, 1.0f));
                c.setBlueF(std::clamp(c.blueF() + errB * factor, 0.0f, 1.0f));
                work.setPixel(nx, ny, c.rgba());
            };

            addError(x + dx, y, 7.0f / 48.0f);
            addError(x + 2 * dx, y, 5.0f / 48.0f);
            addError(x - dx, y + 1, 3.0f / 48.0f);
            addError(x, y + 1, 5.0f / 48.0f);
            addError(x + dx, y + 1, 7.0f / 48.0f);
            addError(x + 2 * dx, y + 1, 5.0f / 48.0f);
            addError(x - 2 * dx, y + 1, 1.0f / 48.0f);
            addError(x + 3 * dx, y, 1.0f / 48.0f);
            addError(x - dx, y + 2, 2.0f / 48.0f);
            addError(x, y + 2, 4.0f / 48.0f);
            addError(x + dx, y + 2, 5.0f / 48.0f);
            addError(x + 2 * dx, y + 2, 4.0f / 48.0f);
            addError(x + 3 * dx, y + 2, 2.0f / 48.0f);
            addError(x + 4 * dx, y, 1.0f / 48.0f);
        }
    }

    img = work;
}

inline void stucki(QImage &img, bool serpentine)
{
    const int w = img.width();
    const int h = img.height();
    QImage work = img;

    for (int y = 0; y < h; ++y) {
        const bool leftToRight = serpentine ? (y % 2 == 0) : true;
        const int startX = leftToRight ? 0 : w - 1;
        const int endX = leftToRight ? w : -1;
        const int dx = leftToRight ? 1 : -1;

        for (int x = startX; x != endX; x += dx) {
            const QColor old(work.pixel(x, y));
            const QColor newC = Color::findClosest(old, {Qt::black, Qt::white});
            work.setPixel(x, y, newC.rgba());

            const float errR = old.redF() - newC.redF();
            const float errG = old.greenF() - newC.greenF();
            const float errB = old.blueF() - newC.blueF();

            const auto addError = [&](int nx, int ny, float factor) {
                if (nx < 0 || ny < 0 || nx >= w || ny >= h)
                    return;
                QColor c(work.pixel(nx, ny));
                c.setRedF(std::clamp(c.redF() + errR * factor, 0.0f, 1.0f));
                c.setGreenF(std::clamp(c.greenF() + errG * factor, 0.0f, 1.0f));
                c.setBlueF(std::clamp(c.blueF() + errB * factor, 0.0f, 1.0f));
                work.setPixel(nx, ny, c.rgba());
            };

            addError(x + dx, y, 8.0f / 42.0f);
            addError(x + 2 * dx, y, 4.0f / 42.0f);
            addError(x - dx, y + 1, 2.0f / 42.0f);
            addError(x, y + 1, 4.0f / 42.0f);
            addError(x + dx, y + 1, 8.0f / 42.0f);
            addError(x + 2 * dx, y + 1, 4.0f / 42.0f);
            addError(x + 3 * dx, y, 2.0f / 42.0f);
            addError(x - 2 * dx, y + 1, 1.0f / 42.0f);
            addError(x - dx, y + 2, 1.0f / 42.0f);
            addError(x, y + 2, 2.0f / 42.0f);
            addError(x + dx, y + 2, 2.0f / 42.0f);
            addError(x + 2 * dx, y + 2, 1.0f / 42.0f);
            addError(x + 3 * dx, y + 1, 1.0f / 42.0f);
            addError(x + 4 * dx, y, 1.0f / 42.0f);
        }
    }

    img = work;
}

inline void burkes(QImage &img, bool serpentine)
{
    const int w = img.width();
    const int h = img.height();
    QImage work = img;

    for (int y = 0; y < h; ++y) {
        const bool leftToRight = serpentine ? (y % 2 == 0) : true;
        const int startX = leftToRight ? 0 : w - 1;
        const int endX = leftToRight ? w : -1;
        const int dx = leftToRight ? 1 : -1;

        for (int x = startX; x != endX; x += dx) {
            const QColor old(work.pixel(x, y));
            const QColor newC = Color::findClosest(old, {Qt::black, Qt::white});
            work.setPixel(x, y, newC.rgba());

            const float errR = old.redF() - newC.redF();
            const float errG = old.greenF() - newC.greenF();
            const float errB = old.blueF() - newC.blueF();

            const auto addError = [&](int nx, int ny, float factor) {
                if (nx < 0 || ny < 0 || nx >= w || ny >= h)
                    return;
                QColor c(work.pixel(nx, ny));
                c.setRedF(std::clamp(c.redF() + errR * factor, 0.0f, 1.0f));
                c.setGreenF(std::clamp(c.greenF() + errG * factor, 0.0f, 1.0f));
                c.setBlueF(std::clamp(c.blueF() + errB * factor, 0.0f, 1.0f));
                work.setPixel(nx, ny, c.rgba());
            };

            addError(x + dx, y, 8.0f / 32.0f);
            addError(x + 2 * dx, y, 4.0f / 32.0f);
            addError(x - dx, y + 1, 2.0f / 32.0f);
            addError(x, y + 1, 4.0f / 32.0f);
            addError(x + dx, y + 1, 8.0f / 32.0f);
            addError(x + 2 * dx, y + 1, 4.0f / 32.0f);
            addError(x + 3 * dx, y, 2.0f / 32.0f);
        }
    }

    img = work;
}

inline void sierra(QImage &img, bool serpentine)
{
    const int w = img.width();
    const int h = img.height();
    QImage work = img;

    for (int y = 0; y < h; ++y) {
        const bool leftToRight = serpentine ? (y % 2 == 0) : true;
        const int startX = leftToRight ? 0 : w - 1;
        const int endX = leftToRight ? w : -1;
        const int dx = leftToRight ? 1 : -1;

        for (int x = startX; x != endX; x += dx) {
            const QColor old(work.pixel(x, y));
            const QColor newC = Color::findClosest(old, {Qt::black, Qt::white});
            work.setPixel(x, y, newC.rgba());

            const float errR = old.redF() - newC.redF();
            const float errG = old.greenF() - newC.greenF();
            const float errB = old.blueF() - newC.blueF();

            const auto addError = [&](int nx, int ny, float factor) {
                if (nx < 0 || ny < 0 || nx >= w || ny >= h)
                    return;
                QColor c(work.pixel(nx, ny));
                c.setRedF(std::clamp(c.redF() + errR * factor, 0.0f, 1.0f));
                c.setGreenF(std::clamp(c.greenF() + errG * factor, 0.0f, 1.0f));
                c.setBlueF(std::clamp(c.blueF() + errB * factor, 0.0f, 1.0f));
                work.setPixel(nx, ny, c.rgba());
            };

            addError(x + dx, y, 5.0f / 32.0f);
            addError(x + 2 * dx, y, 3.0f / 32.0f);
            addError(x - dx, y + 1, 2.0f / 32.0f);
            addError(x, y + 1, 5.0f / 32.0f);
            addError(x + dx, y + 1, 4.0f / 32.0f);
            addError(x + 2 * dx, y + 1, 2.0f / 32.0f);
            addError(x + 3 * dx, y, 2.0f / 32.0f);
            addError(x - dx, y + 2, 1.0f / 32.0f);
            addError(x, y + 2, 2.0f / 32.0f);
            addError(x + dx, y + 2, 1.0f / 32.0f);
        }
    }

    img = work;
}

inline void falseFloydSteinberg(QImage &img, bool serpentine)
{
    const int w = img.width();
    const int h = img.height();
    QImage work = img;

    for (int y = 0; y < h; ++y) {
        const bool leftToRight = serpentine ? (y % 2 == 0) : true;
        const int startX = leftToRight ? 0 : w - 1;
        const int endX = leftToRight ? w : -1;
        const int dx = leftToRight ? 1 : -1;

        for (int x = startX; x != endX; x += dx) {
            const QColor old(work.pixel(x, y));
            const QColor newC = Color::findClosest(old, {Qt::black, Qt::white});
            work.setPixel(x, y, newC.rgba());

            const float errR = old.redF() - newC.redF();
            const float errG = old.greenF() - newC.greenF();
            const float errB = old.blueF() - newC.blueF();

            const auto addError = [&](int nx, int ny, float factor) {
                if (nx < 0 || ny < 0 || nx >= w || ny >= h)
                    return;
                QColor c(work.pixel(nx, ny));
                c.setRedF(std::clamp(c.redF() + errR * factor, 0.0f, 1.0f));
                c.setGreenF(std::clamp(c.greenF() + errG * factor, 0.0f, 1.0f));
                c.setBlueF(std::clamp(c.blueF() + errB * factor, 0.0f, 1.0f));
                work.setPixel(nx, ny, c.rgba());
            };

            addError(x + dx, y + 1, 0.5f);
            addError(x, y + 1, 0.5f);
        }
    }

    img = work;
}

inline void stevensonArce(QImage &img, bool serpentine)
{
    const int w = img.width();
    const int h = img.height();
    QImage work = img;
    const float coeffs[13] = {
        0.0f, 0.0f, 0.0f, 32.0f/200.0f, 12.0f/200.0f, 0.0f,
        26.0f/200.0f, 30.0f/200.0f, 16.0f/200.0f, 0.0f, 16.0f/200.0f,
        12.0f/200.0f, 6.0f/200.0f
    };

    for (int y = 0; y < h; ++y) {
        const bool leftToRight = serpentine ? (y % 2 == 0) : true;
        const int startX = leftToRight ? 0 : w - 1;
        const int endX = leftToRight ? w : -1;
        const int dx = leftToRight ? 1 : -1;

        for (int x = startX; x != endX; x += dx) {
            const QColor old(work.pixel(x, y));
            const QColor newC = Color::findClosest(old, {Qt::black, Qt::white});
            work.setPixel(x, y, newC.rgba());

            const float errR = old.redF() - newC.redF();
            const float errG = old.greenF() - newC.greenF();
            const float errB = old.blueF() - newC.blueF();

            const auto addError = [&](int nx, int ny, float factor) {
                if (nx < 0 || ny < 0 || nx >= w || ny >= h)
                    return;
                QColor c(work.pixel(nx, ny));
                c.setRedF(std::clamp(c.redF() + errR * factor, 0.0f, 1.0f));
                c.setGreenF(std::clamp(c.greenF() + errG * factor, 0.0f, 1.0f));
                c.setBlueF(std::clamp(c.blueF() + errB * factor, 0.0f, 1.0f));
                work.setPixel(nx, ny, c.rgba());
            };

            addError(x + 2 * dx, y - 3, coeffs[0]);
            addError(x - 2 * dx, y - 2, coeffs[1]);
            addError(x + dx, y - 2, coeffs[2]);
            addError(x + 3 * dx, y - 2, coeffs[3]);
            addError(x - 3 * dx, y - 1, coeffs[4]);
            addError(x - dx, y - 1, coeffs[5]);
            addError(x + dx, y - 1, coeffs[6]);
            addError(x + 3 * dx, y - 1, coeffs[7]);
            addError(x + 5 * dx, y - 1, coeffs[8]);
            addError(x - 5 * dx, y, coeffs[9]);
            addError(x - 3 * dx, y, coeffs[10]);
            addError(x - dx, y, coeffs[11]);
            addError(x + dx, y, coeffs[12]);
        }
    }

    img = work;
}

inline void sierraLite(QImage &img, bool serpentine)
{
    const int w = img.width();
    const int h = img.height();
    QImage work = img;

    for (int y = 0; y < h; ++y) {
        const bool leftToRight = serpentine ? (y % 2 == 0) : true;
        const int startX = leftToRight ? 0 : w - 1;
        const int endX = leftToRight ? w : -1;
        const int dx = leftToRight ? 1 : -1;

        for (int x = startX; x != endX; x += dx) {
            const QColor old(work.pixel(x, y));
            const QColor newC = Color::findClosest(old, {Qt::black, Qt::white});
            work.setPixel(x, y, newC.rgba());

            const float errR = old.redF() - newC.redF();
            const float errG = old.greenF() - newC.greenF();
            const float errB = old.blueF() - newC.blueF();

            const auto addError = [&](int nx, int ny, float factor) {
                if (nx < 0 || ny < 0 || nx >= w || ny >= h)
                    return;
                QColor c(work.pixel(nx, ny));
                c.setRedF(std::clamp(c.redF() + errR * factor, 0.0f, 1.0f));
                c.setGreenF(std::clamp(c.greenF() + errG * factor, 0.0f, 1.0f));
                c.setBlueF(std::clamp(c.blueF() + errB * factor, 0.0f, 1.0f));
                work.setPixel(nx, ny, c.rgba());
            };

            addError(x + dx, y, 2.0f / 8.0f);
            addError(x + 2 * dx, y, 1.0f / 8.0f);
            addError(x - dx, y + 1, 1.0f / 8.0f);
            addError(x, y + 1, 1.0f / 8.0f);
            addError(x + dx, y + 1, 1.0f / 8.0f);
        }
    }

    img = work;
}

inline void sierra2(QImage &img, bool serpentine)
{
    const int w = img.width();
    const int h = img.height();
    QImage work = img;

    for (int y = 0; y < h; ++y) {
        const bool leftToRight = serpentine ? (y % 2 == 0) : true;
        const int startX = leftToRight ? 0 : w - 1;
        const int endX = leftToRight ? w : -1;
        const int dx = leftToRight ? 1 : -1;

        for (int x = startX; x != endX; x += dx) {
            const QColor old(work.pixel(x, y));
            const QColor newC = Color::findClosest(old, {Qt::black, Qt::white});
            work.setPixel(x, y, newC.rgba());

            const float errR = old.redF() - newC.redF();
            const float errG = old.greenF() - newC.greenF();
            const float errB = old.blueF() - newC.blueF();

            const auto addError = [&](int nx, int ny, float factor) {
                if (nx < 0 || ny < 0 || nx >= w || ny >= h)
                    return;
                QColor c(work.pixel(nx, ny));
                c.setRedF(std::clamp(c.redF() + errR * factor, 0.0f, 1.0f));
                c.setGreenF(std::clamp(c.greenF() + errG * factor, 0.0f, 1.0f));
                c.setBlueF(std::clamp(c.blueF() + errB * factor, 0.0f, 1.0f));
                work.setPixel(nx, ny, c.rgba());
            };

            addError(x + dx, y, 4.0f / 16.0f);
            addError(x + 2 * dx, y, 3.0f / 16.0f);
            addError(x - 2 * dx, y + 1, 1.0f / 16.0f);
            addError(x - dx, y + 1, 2.0f / 16.0f);
            addError(x, y + 1, 3.0f / 16.0f);
            addError(x + dx, y + 1, 2.0f / 16.0f);
            addError(x + 2 * dx, y + 1, 1.0f / 16.0f);
        }
    }

    img = work;
}

inline void sierra2_4A(QImage &img, bool serpentine)
{
    const int w = img.width();
    const int h = img.height();
    QImage work = img;

    for (int y = 0; y < h; ++y) {
        const bool leftToRight = serpentine ? (y % 2 == 0) : true;
        const int startX = leftToRight ? 0 : w - 1;
        const int endX = leftToRight ? w : -1;
        const int dx = leftToRight ? 1 : -1;

        for (int x = startX; x != endX; x += dx) {
            const QColor old(work.pixel(x, y));
            const QColor newC = Color::findClosest(old, {Qt::black, Qt::white});
            work.setPixel(x, y, newC.rgba());

            const float errR = old.redF() - newC.redF();
            const float errG = old.greenF() - newC.greenF();
            const float errB = old.blueF() - newC.blueF();

            const auto addError = [&](int nx, int ny, float factor) {
                if (nx < 0 || ny < 0 || nx >= w || ny >= h)
                    return;
                QColor c(work.pixel(nx, ny));
                c.setRedF(std::clamp(c.redF() + errR * factor, 0.0f, 1.0f));
                c.setGreenF(std::clamp(c.greenF() + errG * factor, 0.0f, 1.0f));
                c.setBlueF(std::clamp(c.blueF() + errB * factor, 0.0f, 1.0f));
                work.setPixel(nx, ny, c.rgba());
            };

            addError(x + dx, y, 2.0f / 8.0f);
            addError(x + 2 * dx, y, 1.0f / 8.0f);
            addError(x - 2 * dx, y + 1, 1.0f / 8.0f);
            addError(x - dx, y + 1, 1.0f / 8.0f);
            addError(x, y + 1, 1.0f / 8.0f);
            addError(x + dx, y + 1, 1.0f / 8.0f);
            addError(x + 2 * dx, y + 1, 1.0f / 8.0f);
        }
    }

    img = work;
}

inline void runAlgorithm(RunContext &ctx)
{
    QImage img = ctx.preview.isNull() ? ctx.working : ctx.preview;

    const QString alg = ctx.algorithm;
    if (alg == QLatin1String("FloydSteinberg"))
        floydSteinberg(img, ctx.serpentine);
    else if (alg == QLatin1String("FalseFloydSteinberg"))
        falseFloydSteinberg(img, ctx.serpentine);
    else if (alg == QLatin1String("Atkinson"))
        atkinson(img, ctx.serpentine);
    else if (alg == QLatin1String("JarvisJudiceNinke"))
        jarvisJudiceNinke(img, ctx.serpentine);
    else if (alg == QLatin1String("Stucki"))
        stucki(img, ctx.serpentine);
    else if (alg == QLatin1String("Burkes"))
        burkes(img, ctx.serpentine);
    else if (alg == QLatin1String("Sierra"))
        sierra(img, ctx.serpentine);
    else if (alg == QLatin1String("Sierra2"))
        sierra2(img, ctx.serpentine);
    else if (alg == QLatin1String("Sierra2-4A") || alg == QLatin1String("SierraLite"))
        sierra2_4A(img, ctx.serpentine);
    else if (alg == QLatin1String("StevensonArce"))
        stevensonArce(img, ctx.serpentine);
    else if (alg == QLatin1String("Bayer"))
        orderedBayer(img, ctx.bayerSize, ctx.strength);
    else if (alg == QLatin1String("BinaryThreshold"))
        binaryThreshold(img, ctx.threshold);
    else if (alg == QLatin1String("RandomNoise"))
        randomNoise(img);
    else
        orderedBayer(img, ctx.bayerSize, ctx.strength);

    if (ctx.invert)
        applyInvert(img);

    ctx.mutex.lock();
    ctx.preview = img;
    ctx.running = false;
    ctx.mutex.unlock();
}

}

#endif

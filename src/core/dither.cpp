#include "core/dither.h"
#include "core/algorithms.h"
#include "core/color.h"
#include <QFile>
#include <QDateTime>
#include <QStandardPaths>
#include <QImageWriter>
#include <QDir>
#include <QtConcurrent/qtconcurrentrun.h>

using namespace Dizako::Algorithms;

Dizako::DitherEngine::DitherEngine(QObject *parent)
    : QObject(parent)
{
    connect(&m_watcher, &QFutureWatcher<void>::finished,
            this, &DitherEngine::onPreviewFinished);
}

Dizako::DitherEngine::~DitherEngine()
{
    cancel();
}

QList<QColor> Dizako::DitherEngine::palette() const
{
    return m_ctx.palette;
}

void Dizako::DitherEngine::setPalette(const QList<QColor> &palette)
{
    if (m_ctx.palette == palette)
        return;
    m_ctx.palette = palette;
    emit paletteChanged(m_ctx.palette);
    reprocess();
}

void Dizako::DitherEngine::setPaletteColors(const QStringList &colors)
{
    QList<QColor> palette;
    palette.reserve(colors.size());
    for (const QString &c : colors)
        palette.append(QColor(c));
    setPalette(palette);
}

QString Dizako::DitherEngine::sourcePath() const
{
    return m_ctx.sourcePath;
}

void Dizako::DitherEngine::setSourcePath(const QString &path)
{
    if (m_ctx.sourcePath == path)
        return;
    cancel();
    m_ctx.sourcePath = path;
    m_ctx.preview = QImage();
    m_resultPath.clear();
    if (!path.isEmpty()) {
        m_ctx.working = QImage(path);
        if (!m_ctx.working.isNull())
            m_ctx.working = prepareWorking(m_ctx.working, m_ctx.palette, m_ctx.grayscale);
    }
    emit sourcePathChanged(m_ctx.sourcePath);
    emit resultPathChanged(m_resultPath);
    schedulePreview();
}

void Dizako::DitherEngine::setSourceUrl(const QUrl &url)
{
    setSourcePath(url.toLocalFile());
}

QString Dizako::DitherEngine::localPathFromUrl(const QUrl &url) const
{
    return url.toLocalFile();
}

QString Dizako::DitherEngine::resultPath() const
{
    return m_resultPath;
}

QString Dizako::DitherEngine::algorithm() const
{
    return m_ctx.algorithm;
}

void Dizako::DitherEngine::setAlgorithm(const QString &algorithm)
{
    if (m_ctx.algorithm == algorithm)
        return;
    m_ctx.algorithm = algorithm;
    emit algorithmChanged(m_ctx.algorithm);
    reprocess();
}

float Dizako::DitherEngine::strength() const
{
    return m_ctx.strength;
}

void Dizako::DitherEngine::setStrength(float strength)
{
    if (!qFuzzyCompare(m_ctx.strength, strength)) {
        m_ctx.strength = strength;
        emit strengthChanged(m_ctx.strength);
        reprocess();
    }
}

bool Dizako::DitherEngine::serpentine() const
{
    return m_ctx.serpentine;
}

void Dizako::DitherEngine::setSerpentine(bool serpentine)
{
    if (m_ctx.serpentine == serpentine)
        return;
    m_ctx.serpentine = serpentine;
    emit serpentineChanged(m_ctx.serpentine);
    reprocess();
}

int Dizako::DitherEngine::bayerSize() const
{
    return m_ctx.bayerSize;
}

void Dizako::DitherEngine::setBayerSize(int size)
{
    if (m_ctx.bayerSize == size)
        return;
    m_ctx.bayerSize = size;
    emit bayerSizeChanged(m_ctx.bayerSize);
    reprocess();
}

int Dizako::DitherEngine::threshold() const
{
    return m_ctx.threshold;
}

void Dizako::DitherEngine::setThreshold(int threshold)
{
    if (m_ctx.threshold == threshold)
        return;
    m_ctx.threshold = qBound(0, threshold, 255);
    emit thresholdChanged(m_ctx.threshold);
    reprocess();
}

bool Dizako::DitherEngine::invert() const
{
    return m_ctx.invert;
}

void Dizako::DitherEngine::setInvert(bool invert)
{
    if (m_ctx.invert == invert)
        return;
    m_ctx.invert = invert;
    emit invertChanged(m_ctx.invert);
    reprocess();
}

bool Dizako::DitherEngine::grayscale() const
{
    return m_ctx.grayscale;
}

void Dizako::DitherEngine::setGrayscale(bool grayscale)
{
    if (m_ctx.grayscale == grayscale)
        return;
    m_ctx.grayscale = grayscale;
    emit grayscaleChanged(m_ctx.grayscale);
    reprocess();
}

bool Dizako::DitherEngine::processing() const
{
    QMutexLocker locker(&m_mutex);
    return m_ctx.running;
}

void Dizako::DitherEngine::reprocess()
{
    if (m_ctx.sourcePath.isEmpty() || m_ctx.working.isNull())
        return;
    m_ctx.working = prepareWorking(QImage(m_ctx.sourcePath), m_ctx.palette, m_ctx.grayscale);
    schedulePreview();
}

void Dizako::DitherEngine::schedulePreview()
{
    cancel();
    if (m_ctx.sourcePath.isEmpty() || m_ctx.working.isNull())
        return;

    {
        QMutexLocker locker(&m_mutex);
        m_ctx.running = true;
        m_ctx.canceled = false;
        m_ctx.preview = QImage();
    }
    emit processingChanged(true);

    QFuture<void> future = QtConcurrent::run([this]() {
        runAlgorithm(m_ctx);
    });
    m_watcher.setFuture(future);
}

void Dizako::DitherEngine::onPreviewFinished()
{
    bool canceled = false;
    QImage preview;
    {
        QMutexLocker locker(&m_mutex);
        canceled = m_ctx.canceled;
        preview = m_ctx.preview;
        m_ctx.running = false;
    }

    if (!canceled && !preview.isNull()) {
        m_resultPath = saveImage(preview);
        emit resultPathChanged(m_resultPath);
    }
    emit processingChanged(false);
}

void Dizako::DitherEngine::cancel()
{
    {
        QMutexLocker locker(&m_mutex);
        m_ctx.canceled = true;
        m_ctx.running = false;
    }
    if (m_watcher.isRunning())
        m_watcher.waitForFinished();
    {
        QMutexLocker locker(&m_mutex);
        m_ctx.canceled = false;
    }
}

QString Dizako::DitherEngine::saveImage(const QImage &image) const
{
    const QString dir = QStandardPaths::writableLocation(QStandardPaths::TempLocation);
    const QString path = dir + QDir::separator() + "dizako_result_" +
                         QString::number(QDateTime::currentMSecsSinceEpoch()) + ".png";
    if (image.save(path))
        return path;
    return {};
}

QString Dizako::DitherEngine::applyDither(const QString &algorithm)
{
    if (m_ctx.sourcePath.isEmpty() || m_ctx.working.isNull())
        return {};

    m_ctx.algorithm = algorithm;
    schedulePreview();

    QEventLoop loop;
    connect(&m_watcher, &QFutureWatcher<void>::finished, &loop, &QEventLoop::quit);
    loop.exec();

    return m_resultPath;
}

bool Dizako::DitherEngine::exportResult(const QString &destination)
{
    if (m_resultPath.isEmpty())
        return false;
    return QFile::copy(m_resultPath, destination);
}

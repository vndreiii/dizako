#ifndef DITHERENGINE_H
#define DITHERENGINE_H

#include <QObject>
#include <QImage>
#include <QColor>
#include <QList>
#include <QString>
#include <QUrl>
#include <QMutex>
#include <QFutureWatcher>
#include <QtConcurrent/qtconcurrentrun.h>
#include "core/algorithms.h"

namespace Dizako {

class DitherEngine : public QObject
{
    Q_OBJECT
    Q_PROPERTY(QList<QColor> palette READ palette WRITE setPalette NOTIFY paletteChanged)
    Q_PROPERTY(QString sourcePath READ sourcePath WRITE setSourcePath NOTIFY sourcePathChanged)
    Q_PROPERTY(QString resultPath READ resultPath NOTIFY resultPathChanged)
    Q_PROPERTY(QString algorithm READ algorithm WRITE setAlgorithm NOTIFY algorithmChanged)
    Q_PROPERTY(float strength READ strength WRITE setStrength NOTIFY strengthChanged)
    Q_PROPERTY(bool serpentine READ serpentine WRITE setSerpentine NOTIFY serpentineChanged)
    Q_PROPERTY(int bayerSize READ bayerSize WRITE setBayerSize NOTIFY bayerSizeChanged)
    Q_PROPERTY(int threshold READ threshold WRITE setThreshold NOTIFY thresholdChanged)
    Q_PROPERTY(bool invert READ invert WRITE setInvert NOTIFY invertChanged)
    Q_PROPERTY(bool grayscale READ grayscale WRITE setGrayscale NOTIFY grayscaleChanged)
    Q_PROPERTY(bool processing READ processing NOTIFY processingChanged)

public:
    explicit DitherEngine(QObject *parent = nullptr);
    ~DitherEngine() override;

    QList<QColor> palette() const;
    void setPalette(const QList<QColor> &palette);

    QString sourcePath() const;
    void setSourcePath(const QString &path);

    Q_INVOKABLE void setSourceUrl(const QUrl &url);
    Q_INVOKABLE QString localPathFromUrl(const QUrl &url) const;

    QString resultPath() const;

    QString algorithm() const;
    void setAlgorithm(const QString &algorithm);

    float strength() const;
    void setStrength(float strength);

    bool serpentine() const;
    void setSerpentine(bool serpentine);

    int bayerSize() const;
    void setBayerSize(int size);

    int threshold() const;
    void setThreshold(int threshold);

    bool invert() const;
    void setInvert(bool invert);

    bool grayscale() const;
    void setGrayscale(bool grayscale);

    bool processing() const;

    Q_INVOKABLE QString applyDither(const QString &algorithm);
    Q_INVOKABLE void reprocess();
    Q_INVOKABLE bool exportResult(const QString &destination);

signals:
    void paletteChanged(const QList<QColor> &palette);
    void sourcePathChanged(const QString &path);
    void resultPathChanged(const QString &path);
    void algorithmChanged(const QString &algorithm);
    void strengthChanged(float strength);
    void serpentineChanged(bool serpentine);
    void bayerSizeChanged(int size);
    void thresholdChanged(int threshold);
    void invertChanged(bool invert);
    void grayscaleChanged(bool grayscale);
    void processingChanged(bool processing);

private slots:
    void onPreviewFinished();

private:
    void schedulePreview();
    void cancel();
    QString saveImage(const QImage &image) const;

    QString m_resultPath;
    mutable QMutex m_mutex;
    Dizako::Algorithms::RunContext m_ctx;
    QFutureWatcher<void> m_watcher;
};

}

#endif // DITHERENGINE_H

#ifndef DITHERENGINE_H
#define DITHERENGINE_H

#include <QObject>
#include <QImage>
#include <QColor>
#include <QList>
#include <QString>

class DitherEngine : public QObject
{
    Q_OBJECT
    Q_PROPERTY(QList<QColor> palette READ palette WRITE setPalette NOTIFY paletteChanged)
    Q_PROPERTY(QString sourcePath READ sourcePath WRITE setSourcePath NOTIFY sourcePathChanged)
    Q_PROPERTY(QString resultPath READ resultPath NOTIFY resultPathChanged)

public:
    explicit DitherEngine(QObject *parent = nullptr);

    QList<QColor> palette() const;
    void setPalette(const QList<QColor> &palette);

    QString sourcePath() const;
    void setSourcePath(const QString &path);

    QString resultPath() const;

    Q_INVOKABLE QString applyDither(const QString &algorithm);
    Q_INVOKABLE bool exportResult(const QString &destination);

signals:
    void paletteChanged(const QList<QColor> &palette);
    void sourcePathChanged(const QString &path);
    void resultPathChanged(const QString &path);

private:
    QImage loadImage(const QString &path) const;
    QString saveImage(const QImage &image) const;
    QImage applyDither(const QImage &image, const QString &algorithm);

    QList<QColor> m_palette;
    QString m_sourcePath;
    QString m_resultPath;
};

#endif // DITHERENGINE_H

#ifndef DITHERENGINE_H
#define DITHERENGINE_H

#include <QObject>
#include <QImage>
#include <QColor>
#include <QList>

class DitherEngine : public QObject
{
    Q_OBJECT
    Q_PROPERTY(QList<QColor> palette READ palette WRITE setPalette NOTIFY paletteChanged)

public:
    explicit DitherEngine(QObject *parent = nullptr);

    QList<QColor> palette() const;
    void setPalette(const QList<QColor> &palette);

    Q_INVOKABLE QImage applyDither(const QImage &image, const QString &algorithm);

signals:
    void paletteChanged(const QList<QColor> &palette);

private:
    QList<QColor> m_palette;
};

#endif // DITHERENGINE_H

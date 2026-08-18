#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QtQml>
#include "core/dither.h"

int main(int argc, char *argv[])
{
    QGuiApplication app(argc, argv);

    qmlRegisterSingletonInstance<Dizako::DitherEngine>("App", 1, 0, "DitherEngine",
                                                        new Dizako::DitherEngine);

    QQmlApplicationEngine engine;
    engine.loadFromModule("App", "Main");
    if (engine.rootObjects().isEmpty())
        return -1;

    return app.exec();
}

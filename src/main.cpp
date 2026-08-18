#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QtQml>
#include "core/dither.h"

using namespace Dizako;

int main(int argc, char *argv[])
{
    QGuiApplication app(argc, argv);

    qmlRegisterSingletonInstance<DitherEngine>("App", 1, 0, "DitherEngine",
                                                        new DitherEngine);

    QQmlApplicationEngine engine;
    engine.loadFromModule("App", "Main");
    if (engine.rootObjects().isEmpty())
        return -1;

    return app.exec();
}

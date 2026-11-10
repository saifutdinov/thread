package io.github.saifutdinov.thread

import android.app.Application

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Kept.init(this)
        Notes.channels(this)
    }
}

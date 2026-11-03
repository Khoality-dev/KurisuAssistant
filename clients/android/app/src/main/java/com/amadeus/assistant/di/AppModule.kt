package com.amadeus.assistant.di

import android.content.Context
import com.amadeus.assistant.data.local.EncryptedPreferences
import com.amadeus.assistant.data.local.PreferencesDataStore
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import java.time.Clock
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    fun providePreferencesDataStore(@ApplicationContext context: Context): PreferencesDataStore =
        PreferencesDataStore(context)

    @Provides
    @Singleton
    fun provideEncryptedPreferences(@ApplicationContext context: Context): EncryptedPreferences =
        EncryptedPreferences(context)

    @Provides
    @Singleton
    fun provideNotificationDelivery(
        delivery: com.amadeus.assistant.service.AndroidNotificationDelivery,
    ): com.amadeus.assistant.service.NotificationDelivery = delivery

    @Provides
    @Singleton
    fun provideFcmTokenSource(
        source: com.amadeus.assistant.data.push.FirebaseTokenSource,
    ): com.amadeus.assistant.data.push.FcmTokenSource = source

    /**
     * The device's clock and zone (#282). Not a singleton: the zone is read
     * when a screen asks, so a phone that crossed a time zone shows the new one.
     */
    @Provides
    fun provideClock(): Clock = Clock.systemDefaultZone()
}

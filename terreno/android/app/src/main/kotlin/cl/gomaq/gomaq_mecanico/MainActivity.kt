package cl.gomaq.gomaq_mecanico

import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        crearCanalAvisos()
    }

    // Canal de los avisos push de ordenes (el id va en el manifiesto como canal por defecto de FCM).
    // Distinto del canal "Viaje en curso" del servicio de posicion. Crearlo de nuevo es inofensivo.
    private fun crearCanalAvisos() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val canal = NotificationChannel(
            "avisos_ordenes",
            "Avisos de órdenes",
            NotificationManager.IMPORTANCE_HIGH,
        )
        canal.description = "Órdenes asignadas o disponibles para tomar"
        getSystemService(NotificationManager::class.java).createNotificationChannel(canal)
    }
}

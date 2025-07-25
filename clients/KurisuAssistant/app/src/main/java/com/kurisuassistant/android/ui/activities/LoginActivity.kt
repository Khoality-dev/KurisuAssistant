package com.kurisuassistant.android

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.Toast
import com.kurisuassistant.android.Settings
import androidx.appcompat.app.AppCompatActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.Request
import okhttp3.OkHttpClient
import okhttp3.FormBody

class LoginActivity : AppCompatActivity() {
    private val scope = CoroutineScope(Dispatchers.IO)
    private val client = OkHttpClient()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_login)
        Auth.init(this)
        Settings.init(this)
        if (Auth.token != null) {
            startActivity(Intent(this, MainActivity::class.java))
            finish()
            return
        }
        val username = findViewById<EditText>(R.id.editUsername)
        val password = findViewById<EditText>(R.id.editPassword)
        val remember = findViewById<CheckBox>(R.id.checkRemember)
        val button = findViewById<Button>(R.id.buttonLogin)
        button.setOnClickListener {
            val user = username.text.toString()
            val pass = password.text.toString()
            scope.launch {
                val token = login(user, pass)
                if (token != null) {
                    Auth.setToken(token, remember.isChecked)
                    startActivity(Intent(this@LoginActivity, MainActivity::class.java))
                    finish()
                } else {
                    runOnUiThread {
                        Toast.makeText(this@LoginActivity, "Login failed", Toast.LENGTH_SHORT).show()
                    }
                }
            }
        }
    }

    private fun login(user: String, pass: String): String? {
        val body = okhttp3.FormBody.Builder()
            .add("username", user)
            .add("password", pass)
            .build()
        val request = Request.Builder()
            .url("${Settings.llmUrl}/login")
            .post(body)
            .build()
        client.newCall(request).execute().use { resp ->
            if (!resp.isSuccessful) return null
            val json = org.json.JSONObject(resp.body!!.string())
            return json.getString("access_token")
        }
    }
}

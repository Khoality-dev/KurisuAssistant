package com.kurisuassistant.android

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.FormBody
import okhttp3.Request
import com.kurisuassistant.android.utils.HttpClient

class GettingStartedActivity : AppCompatActivity() {
    private val scope = CoroutineScope(Dispatchers.IO)

    private lateinit var llmUrl: EditText
    private lateinit var ttsUrl: EditText
    private lateinit var username: EditText
    private lateinit var password: EditText
    private lateinit var registerForm: View

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Auth.init(this)
        Settings.init(this)

        if (!Settings.firstRun) {
            startNext()
            return
        }

        setContentView(R.layout.activity_getting_started)
        llmUrl = findViewById(R.id.setupLlmUrl)
        ttsUrl = findViewById(R.id.setupTtsUrl)
        username = findViewById(R.id.setupUsername)
        password = findViewById(R.id.setupPassword)
        registerForm = findViewById(R.id.registerForm)

        findViewById<Button>(R.id.buttonCheckUrls).setOnClickListener { validateUrls() }
        findViewById<Button>(R.id.buttonRegisterAdmin).setOnClickListener { register() }
    }

    private fun startNext() {
        if (Auth.token != null) {
            startActivity(Intent(this, MainActivity::class.java))
        } else {
            startActivity(Intent(this, LoginActivity::class.java))
        }
        finish()
    }

    private fun validateUrls() {
        val llm = llmUrl.text.toString().trim()
        val tts = ttsUrl.text.toString().trim()
        scope.launch {
            val okLlm = checkUrl("$llm/openapi.json")
            val okTts = tts.isBlank() || checkUrl("$tts/openapi.json")
            val needsAdmin = if (okLlm && okTts) serverNeedsAdmin() else false
            runOnUiThread {
                if (okLlm && okTts) {
                    Settings.save(llm, if (tts.isBlank()) Settings.ttsUrl else tts, Settings.model)
                    Settings.markConfigured()
                    if (needsAdmin) {
                        registerForm.visibility = View.VISIBLE
                    } else {
                        startNext()
                    }
                    Toast.makeText(this@GettingStartedActivity, "Hubs saved", Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(this@GettingStartedActivity, "Invalid hub URLs", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun checkUrl(url: String): Boolean {
        return try {
            val req = Request.Builder().url(url).build()
            HttpClient.noTimeout.newCall(req).execute().use { it.isSuccessful }
        } catch (e: Exception) {
            false
        }
    }

    private fun serverNeedsAdmin(): Boolean {
        return try {
            val req = Request.Builder().url("${Settings.llmUrl}/needs-admin").build()
            HttpClient.noTimeout.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return false
                val json = org.json.JSONObject(resp.body!!.string())
                json.optBoolean("needs_admin", false)
            }
        } catch (_: Exception) {
            false
        }
    }

    private fun register() {
        val user = username.text.toString()
        val pass = password.text.toString()
        scope.launch {
            val body = FormBody.Builder().add("username", user).add("password", pass).build()
            val request = Request.Builder().url("${Settings.llmUrl}/register").post(body).build()
            val result = try {
                HttpClient.noTimeout.newCall(request).execute().use { resp ->
                    resp.isSuccessful || (resp.code == 400 && resp.body?.string()?.contains("User already exists") == true)
                }
            } catch (_: Exception) {
                false
            }
            runOnUiThread {
                if (result) {
                    Settings.markConfigured()
                    Toast.makeText(this@GettingStartedActivity, "Admin ready", Toast.LENGTH_SHORT).show()
                    startNext()
                } else {
                    Toast.makeText(this@GettingStartedActivity, "Registration failed", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }
}

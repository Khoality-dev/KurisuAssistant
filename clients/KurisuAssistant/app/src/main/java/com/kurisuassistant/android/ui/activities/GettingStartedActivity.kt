package com.kurisuassistant.android

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.FormBody
import okhttp3.Request
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.io.IOException

class GettingStartedActivity : AppCompatActivity() {
    private val scope = CoroutineScope(Dispatchers.IO)

    private lateinit var llmUrl: EditText
    private lateinit var ttsUrl: EditText
    private lateinit var modelSpinner: Spinner
    private lateinit var username: EditText
    private lateinit var password: EditText
    private lateinit var registerForm: View
    private val client = OkHttpClient()

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
        modelSpinner = findViewById(R.id.setupModelSpinner)
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
                    loadModels()
                    if (needsAdmin) {
                        registerForm.visibility = View.VISIBLE
                    } else {
                        saveSelectedModel()
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
            val request = Request.Builder()
                .url(url)
                .build()
            client.newCall(request).execute().use { it.isSuccessful }
        } catch (e: Exception) {
            false
        }
    }

    private fun serverNeedsAdmin(): Boolean {
        return try {
            val request = Request.Builder()
                .url("${Settings.llmUrl}/needs-admin")
                .build()
            client.newCall(request).execute().use { resp ->
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
            val result = try {
                val request = Request.Builder()
                    .url("${Settings.llmUrl}/register")
                    .post(body)
                    .build()
                client.newCall(request).execute().use { resp ->
                    resp.isSuccessful || (resp.code == 400 && resp.body?.string()?.contains("User already exists") == true)
                }
            } catch (_: Exception) {
                false
            }
            runOnUiThread {
                if (result) {
                    saveSelectedModel()
                    Settings.markConfigured()
                    Toast.makeText(this@GettingStartedActivity, "Admin ready", Toast.LENGTH_SHORT).show()
                    startNext()
                } else {
                    Toast.makeText(this@GettingStartedActivity, "Registration failed", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun loadModels() {
        val url = llmUrl.text.toString().trim()
        runOnUiThread { modelSpinner.isEnabled = false }
        if (url.isEmpty()) {
            return
        }
        val requestBuilder = Request.Builder()
            .url("$url/models")
        Auth.token?.let { requestBuilder.addHeader("Authorization", "Bearer $it") }
        val request = requestBuilder.build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                runOnUiThread { 
                    modelSpinner.isEnabled = false
                    modelSpinner.visibility = View.GONE
                }
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (!it.isSuccessful) {
                        onFailure(call, IOException("HTTP" + it.code))
                        return
                    }
                    val arr = JSONObject(it.body!!.string()).optJSONArray("models")
                        ?: return
                    val names = mutableListOf<String>()
                    for (i in 0 until arr.length()) names.add(arr.getString(i))
                    runOnUiThread {
                        if (names.isNotEmpty()) {
                            val adapter = ArrayAdapter(this@GettingStartedActivity,
                                android.R.layout.simple_spinner_item, names)
                            adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
                            modelSpinner.adapter = adapter
                            modelSpinner.isEnabled = true
                            modelSpinner.visibility = View.VISIBLE
                            val current = if (Settings.model.isNotEmpty()) Settings.model else names.firstOrNull() ?: ""
                            val idx = names.indexOf(current).takeIf { it >= 0 } ?: 0
                            modelSpinner.setSelection(idx)
                        }
                    }
                }
            }
        })
    }

    private fun saveSelectedModel() {
        if (modelSpinner.adapter != null && modelSpinner.selectedItem != null) {
            val selectedModel = modelSpinner.selectedItem.toString()
            Settings.save(Settings.llmUrl, Settings.ttsUrl, selectedModel)
        }
    }
}

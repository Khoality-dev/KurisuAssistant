package com.kurisuassistant.android

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import androidx.appcompat.app.AppCompatActivity
import com.yalantis.ucrop.UCrop
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import android.widget.ArrayAdapter
import android.widget.ProgressBar
import android.view.View
import com.google.android.material.appbar.MaterialToolbar
import com.kurisuassistant.android.utils.HttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.IOException
import android.widget.ImageView
import android.widget.Toast
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import android.util.Patterns
import kotlinx.coroutines.launch
import java.io.File

class SettingsActivity : AppCompatActivity() {

    private lateinit var userAvatar: ImageView
    private lateinit var agentAvatar: ImageView
    private lateinit var llmUrl: EditText
    private lateinit var ttsUrl: EditText
    private lateinit var modelSpinner: Spinner
    private lateinit var systemPrompt: EditText
    private lateinit var llmValidationProgress: ProgressBar
    private lateinit var llmValidationIcon: ImageView
    private lateinit var ttsValidationProgress: ProgressBar
    private lateinit var ttsValidationIcon: ImageView
    private val client = HttpClient.noTimeout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        
        val toolbar = findViewById<MaterialToolbar>(R.id.toolbar)
        setSupportActionBar(toolbar)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        supportActionBar?.title = "Settings"
        
        AvatarManager.init(this)
        Settings.init(this)

        userAvatar = findViewById(R.id.userAvatar)
        agentAvatar = findViewById(R.id.agentAvatar)
        llmUrl = findViewById(R.id.editLlmUrl)
        ttsUrl = findViewById(R.id.editTtsUrl)
        modelSpinner = findViewById(R.id.spinnerModel)
        systemPrompt = findViewById(R.id.editSystemPrompt)
        llmValidationProgress = findViewById(R.id.llmValidationProgress)
        llmValidationIcon = findViewById(R.id.llmValidationIcon)
        ttsValidationProgress = findViewById(R.id.ttsValidationProgress)
        ttsValidationIcon = findViewById(R.id.ttsValidationIcon)

        llmUrl.setText(Settings.llmUrl)
        ttsUrl.setText(Settings.ttsUrl)
        systemPrompt.setText(Settings.systemPrompt)
        
        // Load system prompt from server
        loadSystemPrompt()

        AvatarManager.getUserAvatarUri()?.let { userAvatar.setImageURI(it) }
        AvatarManager.getAgentAvatarUri()?.let { agentAvatar.setImageURI(it) }

        userAvatar.setOnClickListener { pickImage(USER_PICK) }
        agentAvatar.setOnClickListener { pickImage(AGENT_PICK) }



        llmUrl.setOnFocusChangeListener { _, hasFocus ->
            if (!hasFocus) {
                validateLlmUrl()
                loadModels()
                saveSettings()
            }
        }

        ttsUrl.setOnFocusChangeListener { _, hasFocus ->
            if (!hasFocus) {
                validateTtsUrl()
                saveSettings()
            }
        }

        systemPrompt.setOnFocusChangeListener { _, hasFocus ->
            if (!hasFocus) {
                saveSystemPrompt(systemPrompt.text.toString().trim())
            }
        }

        // Add click listeners for manual revalidation
        llmValidationIcon.setOnClickListener {
            validateLlmUrl()
        }
        
        ttsValidationIcon.setOnClickListener {
            validateTtsUrl()
        }

        // Validate URLs when page opens
        validateLlmUrl()
        validateTtsUrl()

        loadModels()
    }

    override fun onSupportNavigateUp(): Boolean {
        onBackPressed()
        return true
    }

    private fun pickImage(code: Int) {
        val intent = Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI)
        intent.type = "image/*"
        startActivityForResult(intent, code)
    }

    private fun startCrop(source: Uri, request: Int) {
        val dest = Uri.fromFile(File(filesDir, if (request == USER_CROP) "user_avatar.jpg" else "agent_avatar.jpg"))
        UCrop.of(source, dest)
            .withAspectRatio(1f, 1f)
            .withMaxResultSize(512, 512)
            .start(this, request)
    }

    private fun loadModels() {
        val url = llmUrl.text.toString().trim()
        runOnUiThread { modelSpinner.isEnabled = false }
        if (!Patterns.WEB_URL.matcher(url).matches()) {
            return
        }
        val request = Request.Builder()
            .url("$url/models")
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                runOnUiThread { modelSpinner.isEnabled = false }
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
                        val adapter = ArrayAdapter(this@SettingsActivity,
                            android.R.layout.simple_spinner_item, names)
                        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
                        modelSpinner.adapter = adapter
                        modelSpinner.isEnabled = true
                        val current = if (Settings.model.isNotEmpty()) Settings.model else names.firstOrNull() ?: ""
                        val idx = names.indexOf(current).takeIf { it >= 0 } ?: 0
                        Settings.model = current
                        modelSpinner.setSelection(idx)
                        
                        // Add listener for auto-save on model selection change
                        modelSpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                            override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: android.view.View?, position: Int, id: Long) {
                                saveSettings()
                            }
                            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
                        }
                    }
                }
            }
        })
    }

    private fun loadSystemPrompt() {
        kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).launch {
            try {
                val response = HttpClient.get("${Settings.llmUrl}/system-prompt", Auth.token ?: "")
                val json = JSONObject(response)
                val serverSystemPrompt = json.optString("system_prompt", "")
                
                runOnUiThread {
                    systemPrompt.setText(serverSystemPrompt)
                    Settings.saveSystemPrompt(serverSystemPrompt)
                }
            } catch (e: Exception) {
                // If we can't load from server, use local value
                runOnUiThread {
                    systemPrompt.setText(Settings.systemPrompt)
                }
            }
        }
    }

    private fun saveSystemPrompt(prompt: String) {
        kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).launch {
            try {
                val requestBody = JSONObject().apply {
                    put("system_prompt", prompt)
                }.toString().toRequestBody("application/json".toMediaType())
                
                HttpClient.put("${Settings.llmUrl}/system-prompt", requestBody, Auth.token ?: "").use { response ->
                    if (response.isSuccessful) {
                        // Also save locally as backup
                        Settings.saveSystemPrompt(prompt)
                        runOnUiThread {
                            Toast.makeText(this@SettingsActivity, "Settings saved", Toast.LENGTH_SHORT).show()
                        }
                    } else {
                        runOnUiThread {
                            Toast.makeText(this@SettingsActivity, "Failed to save system prompt", Toast.LENGTH_SHORT).show()
                        }
                    }
                }
            } catch (e: Exception) {
                runOnUiThread {
                    Toast.makeText(this@SettingsActivity, "Error saving system prompt: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun saveSettings() {
        Settings.save(
            llmUrl.text.toString().trim(),
            ttsUrl.text.toString().trim(),
            modelSpinner.selectedItem?.toString() ?: ""
        )
    }

    private fun validateLlmUrl() {
        val url = llmUrl.text.toString().trim()
        if (url.isEmpty() || !Patterns.WEB_URL.matcher(url).matches()) {
            showLlmValidationState(ValidationState.NONE)
            return
        }

        showLlmValidationState(ValidationState.VALIDATING)
        
        kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).launch {
            try {
                val request = Request.Builder()
                    .url("$url/health")
                    .build()
                
                client.newCall(request).execute().use { response ->
                    runOnUiThread {
                        if (response.isSuccessful) {
                            showLlmValidationState(ValidationState.VALID)
                        } else {
                            showLlmValidationState(ValidationState.INVALID)
                        }
                    }
                }
            } catch (e: Exception) {
                runOnUiThread {
                    showLlmValidationState(ValidationState.INVALID)
                }
            }
        }
    }

    private fun validateTtsUrl() {
        val url = ttsUrl.text.toString().trim()
        if (url.isEmpty() || !Patterns.WEB_URL.matcher(url).matches()) {
            showTtsValidationState(ValidationState.NONE)
            return
        }

        showTtsValidationState(ValidationState.VALIDATING)
        
        kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).launch {
            try {
                val request = Request.Builder()
                    .url("$url/health")
                    .build()
                
                client.newCall(request).execute().use { response ->
                    runOnUiThread {
                        if (response.isSuccessful) {
                            showTtsValidationState(ValidationState.VALID)
                        } else {
                            showTtsValidationState(ValidationState.INVALID)
                        }
                    }
                }
            } catch (e: Exception) {
                runOnUiThread {
                    showTtsValidationState(ValidationState.INVALID)
                }
            }
        }
    }

    private fun showLlmValidationState(state: ValidationState) {
        when (state) {
            ValidationState.NONE -> {
                llmValidationProgress.visibility = View.GONE
                llmValidationIcon.visibility = View.GONE
            }
            ValidationState.VALIDATING -> {
                llmValidationProgress.visibility = View.VISIBLE
                llmValidationIcon.visibility = View.GONE
            }
            ValidationState.VALID -> {
                llmValidationProgress.visibility = View.GONE
                llmValidationIcon.visibility = View.VISIBLE
                llmValidationIcon.setImageResource(android.R.drawable.presence_online)
                llmValidationIcon.setColorFilter(android.graphics.Color.GREEN)
            }
            ValidationState.INVALID -> {
                llmValidationProgress.visibility = View.GONE
                llmValidationIcon.visibility = View.VISIBLE
                llmValidationIcon.setImageResource(android.R.drawable.ic_dialog_alert)
                llmValidationIcon.setColorFilter(android.graphics.Color.RED)
            }
        }
    }

    private fun showTtsValidationState(state: ValidationState) {
        when (state) {
            ValidationState.NONE -> {
                ttsValidationProgress.visibility = View.GONE
                ttsValidationIcon.visibility = View.GONE
            }
            ValidationState.VALIDATING -> {
                ttsValidationProgress.visibility = View.VISIBLE
                ttsValidationIcon.visibility = View.GONE
            }
            ValidationState.VALID -> {
                ttsValidationProgress.visibility = View.GONE
                ttsValidationIcon.visibility = View.VISIBLE
                ttsValidationIcon.setImageResource(android.R.drawable.presence_online)
                ttsValidationIcon.setColorFilter(android.graphics.Color.GREEN)
            }
            ValidationState.INVALID -> {
                ttsValidationProgress.visibility = View.GONE
                ttsValidationIcon.visibility = View.VISIBLE
                ttsValidationIcon.setImageResource(android.R.drawable.ic_dialog_alert)
                ttsValidationIcon.setColorFilter(android.graphics.Color.RED)
            }
        }
    }

    private enum class ValidationState {
        NONE, VALIDATING, VALID, INVALID
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK || data == null) return
        when (requestCode) {
            USER_PICK -> startCrop(data.data!!, USER_CROP)
            AGENT_PICK -> startCrop(data.data!!, AGENT_CROP)
            USER_CROP -> {
                val uri = UCrop.getOutput(data) ?: return
                AvatarManager.setUserAvatar(uri)
                userAvatar.setImageURI(uri)
            }
            AGENT_CROP -> {
                val uri = UCrop.getOutput(data) ?: return
                AvatarManager.setAgentAvatar(uri)
                agentAvatar.setImageURI(uri)
            }
        }
    }

    companion object {
        private const val USER_PICK = 1
        private const val AGENT_PICK = 2
        private const val USER_CROP = 3
        private const val AGENT_CROP = 4
    }
}


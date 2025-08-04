package com.kurisuassistant.android

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.util.Log
import androidx.appcompat.app.AppCompatActivity
import com.yalantis.ucrop.UCrop
import android.widget.Button
import android.widget.EditText
import android.widget.Spinner
import android.widget.ArrayAdapter
import android.widget.ProgressBar
import android.view.View
import com.google.android.material.appbar.MaterialToolbar
import okhttp3.Request
import okhttp3.OkHttpClient
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
import androidx.core.content.ContextCompat
import kotlinx.coroutines.launch
import okhttp3.MultipartBody
import java.io.File
import java.util.concurrent.TimeUnit

class SettingsActivity : AppCompatActivity() {

    private lateinit var userAvatar: ImageView
    private lateinit var agentAvatar: ImageView
    private lateinit var llmUrl: EditText
    private lateinit var ttsUrl: EditText
    private lateinit var modelSpinner: Spinner
    private lateinit var preferredName: EditText
    private lateinit var systemPrompt: EditText
    private lateinit var llmValidationProgress: ProgressBar
    private lateinit var llmValidationIcon: ImageView
    private lateinit var ttsValidationProgress: ProgressBar
    private lateinit var ttsValidationIcon: ImageView
    private lateinit var saveButton: Button
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()
    private var hasUnsavedChanges = false
    
    // Change tracking
    private var systemPromptChanged = false
    private var preferredNameChanged = false
    private var userAvatarChanged = false
    private var agentAvatarChanged = false
    private var newUserAvatarUri: Uri? = null
    private var newAgentAvatarUri: Uri? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        
        val toolbar = findViewById<MaterialToolbar>(R.id.toolbar)
        setSupportActionBar(toolbar)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        supportActionBar?.title = "Settings"
        
        Auth.init(this)
        AvatarManager.init(this)
        Settings.init(this)

        userAvatar = findViewById(R.id.userAvatar)
        agentAvatar = findViewById(R.id.agentAvatar)
        llmUrl = findViewById(R.id.editLlmUrl)
        ttsUrl = findViewById(R.id.editTtsUrl)
        modelSpinner = findViewById(R.id.spinnerModel)
        preferredName = findViewById(R.id.editPreferredName)
        systemPrompt = findViewById(R.id.editSystemPrompt)
        llmValidationProgress = findViewById(R.id.llmValidationProgress)
        llmValidationIcon = findViewById(R.id.llmValidationIcon)
        ttsValidationProgress = findViewById(R.id.ttsValidationProgress)
        ttsValidationIcon = findViewById(R.id.ttsValidationIcon)
        saveButton = findViewById(R.id.buttonSave)

        llmUrl.setText(Settings.llmUrl)
        ttsUrl.setText(Settings.ttsUrl)
        systemPrompt.setText(Settings.systemPrompt)
        
        // Load user profile from server if URL is configured
        if (Settings.llmUrl.isNotEmpty()) {
            loadUserProfile()
        }

        AvatarManager.getUserAvatarUri()?.let { userAvatar.setImageURI(it) }
        AvatarManager.getAgentAvatarUri()?.let { agentAvatar.setImageURI(it) }

        userAvatar.setOnClickListener { pickImage(USER_PICK) }
        agentAvatar.setOnClickListener { pickImage(AGENT_PICK) }



        llmUrl.setOnFocusChangeListener { _, hasFocus ->
            if (!hasFocus) {
                validateLlmUrl()
                loadModels()
            }
        }

        ttsUrl.setOnFocusChangeListener { _, hasFocus ->
            if (!hasFocus) {
                validateTtsUrl()
            }
        }

        // Save button click handler
        saveButton.setOnClickListener {
            saveAllSettings()
        }

        // Add text change listeners to detect unsaved changes
        llmUrl.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) { markUnsavedChanges() }
        })

        ttsUrl.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) { markUnsavedChanges() }
        })

        preferredName.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) { 
                preferredNameChanged = true
                markUnsavedChanges() 
            }
        })

        systemPrompt.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) { 
                systemPromptChanged = true
                markUnsavedChanges() 
            }
        })

        // Add click listeners for manual revalidation
        llmValidationIcon.setOnClickListener {
            validateLlmUrl()
        }
        
        ttsValidationIcon.setOnClickListener {
            validateTtsUrl()
        }

        // Only validate URLs if they're not empty
        if (llmUrl.text.toString().trim().isNotEmpty()) {
            validateLlmUrl()
        }
        if (ttsUrl.text.toString().trim().isNotEmpty()) {
            validateTtsUrl()
        }

        // Only load models if LLM URL is configured
        if (llmUrl.text.toString().trim().isNotEmpty()) {
            loadModels()
        }
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
            .addHeader("Authorization", "Bearer ${Auth.token}")
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
                        
                        // Add listener to mark unsaved changes on model selection
                        modelSpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                            override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: android.view.View?, position: Int, id: Long) {
                                markUnsavedChanges()
                            }
                            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
                        }
                    }
                }
            }
        })
    }

    private fun loadUserProfile() {
        val token = Auth.token
        if (token == null) {
            // If no token, just use local value
            systemPrompt.setText(Settings.systemPrompt)
            return
        }
        
        val request = Request.Builder()
            .url("${Settings.llmUrl}/user")
            .addHeader("Authorization", "Bearer ${Auth.token}")
            .build() 
            
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                // If we can't load from server, use local value
                runOnUiThread {
                    systemPrompt.setText(Settings.systemPrompt)
                }
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (!it.isSuccessful) {
                        onFailure(call, IOException("HTTP ${it.code}"))
                        return
                    }
                    val json = JSONObject(it.body!!.string())
                    val serverSystemPrompt = json.optString("system_prompt", "")
                    val serverPreferredName = json.optString("preferred_name", "")
                    
                    runOnUiThread {
                        systemPrompt.setText(serverSystemPrompt)
                        preferredName.setText(serverPreferredName)
                        Settings.saveSystemPrompt(serverSystemPrompt)
                    }
                }
            }
        })
    }


    private fun saveSettings() {
        Settings.save(
            llmUrl.text.toString().trim(),
            ttsUrl.text.toString().trim(),
            modelSpinner.selectedItem?.toString() ?: ""
        )
    }

    private fun saveAllSettings() {
        // Show loading state
        saveButton.isEnabled = false
        saveButton.text = "Saving..."
        
        // Save local settings first
        saveSettings()
        
        // Check if there are any changes to send to server
        val hasChangesToSend = systemPromptChanged || preferredNameChanged || userAvatarChanged || agentAvatarChanged
        
        if (!hasChangesToSend) {
            // No changes to send to server, just mark as saved
            runOnUiThread {
                Toast.makeText(this@SettingsActivity, "No changes to save", Toast.LENGTH_SHORT).show()
                markChangesSaved()
                saveButton.isEnabled = true
                saveButton.text = "Save Settings"
            }
            return
        }
        
        // Save user profile to server - only send changed fields
        val formBodyBuilder = MultipartBody.Builder().setType(MultipartBody.FORM)
        
        if (systemPromptChanged) {
            val prompt = systemPrompt.text.toString().trim()
            formBodyBuilder.addFormDataPart("system_prompt", prompt)
            Settings.saveSystemPrompt(prompt)
        }
        
        if (preferredNameChanged) {
            val preferredNameText = preferredName.text.toString().trim()
            formBodyBuilder.addFormDataPart("preferred_name", preferredNameText)
        }
        
        if (userAvatarChanged && newUserAvatarUri != null) {
            val inputStream = contentResolver.openInputStream(newUserAvatarUri!!)
            val bytes = inputStream?.readBytes()
            inputStream?.close()
            if (bytes != null) {
                formBodyBuilder.addFormDataPart(
                    "user_avatar", "user_avatar.jpg",
                    bytes.toRequestBody("image/jpeg".toMediaType())
                )
            }
        }
        
        if (agentAvatarChanged && newAgentAvatarUri != null) {
            val inputStream = contentResolver.openInputStream(newAgentAvatarUri!!)
            val bytes = inputStream?.readBytes()
            inputStream?.close()
            if (bytes != null) {
                formBodyBuilder.addFormDataPart(
                    "agent_avatar", "agent_avatar.jpg",
                    bytes.toRequestBody("image/jpeg".toMediaType())
                )
            }
        }
        
        val requestBody = formBodyBuilder.build()
        val request = Request.Builder()
            .url("${Settings.llmUrl}/user")
            .put(requestBody)
            .addHeader("Authorization", "Bearer ${Auth.token}")
            .build()
            
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                runOnUiThread {
                    // Save locally even if server fails (only for system prompt)
                    if (systemPromptChanged) {
                        val prompt = systemPrompt.text.toString().trim()
                        Settings.saveSystemPrompt(prompt)
                        // Only reset system prompt flag since we saved it locally
                        systemPromptChanged = false
                    }
                    
                    // Check if all changes are now handled
                    val allChangesSaved = !systemPromptChanged && !preferredNameChanged && !userAvatarChanged && !agentAvatarChanged
                    
                    if (allChangesSaved) {
                        Toast.makeText(this@SettingsActivity, "Settings saved locally (server unavailable)", Toast.LENGTH_LONG).show()
                        markChangesSaved()
                    } else {
                        Toast.makeText(this@SettingsActivity, "Server error: ${e.message}. Some changes could not be saved.", Toast.LENGTH_LONG).show()
                        // Keep showing unsaved changes indicator
                    }
                    
                    // Reset button state
                    saveButton.isEnabled = true
                    saveButton.text = if (allChangesSaved) "Save Settings" else "Save Settings *"
                }
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val responseBody = if (it.isSuccessful) it.body?.string() else null
                    runOnUiThread {
                        if (it.isSuccessful) {
                            try {
                                Log.d("SettingsActivity", "Server response: $responseBody")
                                
                                if (responseBody.isNullOrEmpty()) {
                                    Toast.makeText(this@SettingsActivity, "Server error: Empty response", Toast.LENGTH_LONG).show()
                                    return@runOnUiThread
                                }
                                
                                val json = JSONObject(responseBody)
                                val serverUserUuid = if (json.isNull("user_avatar_uuid")) null else json.optString("user_avatar_uuid")
                                val serverAgentUuid = if (json.isNull("agent_avatar_uuid")) null else json.optString("agent_avatar_uuid")
                                
                                // Update UUIDs from server response
                                if (userAvatarChanged) {
                                    AvatarManager.updateUserAvatarUuid(serverUserUuid)
                                }
                                if (agentAvatarChanged) {
                                    AvatarManager.updateAgentAvatarUuid(serverAgentUuid)
                                }
                                
                                // Refresh avatar display in settings
                                AvatarManager.getUserAvatarUri()?.let { 
                                    userAvatar.setImageURI(null) // Clear cache
                                    userAvatar.setImageURI(it) 
                                }
                                AvatarManager.getAgentAvatarUri()?.let { 
                                    agentAvatar.setImageURI(null) // Clear cache
                                    agentAvatar.setImageURI(it) 
                                }
                                
                                Toast.makeText(this@SettingsActivity, "Settings saved successfully", Toast.LENGTH_SHORT).show()
                                resetChangeTracking()
                                markChangesSaved()
                            } catch (e: Exception) {
                                Log.e("SettingsActivity", "Failed to parse response. Body: '$responseBody'", e)
                                Toast.makeText(this@SettingsActivity, "Server error: Invalid response format - ${e.message}", Toast.LENGTH_LONG).show()
                                // Don't reset tracking since we couldn't confirm what was saved
                            }
                        } else {
                            Toast.makeText(this@SettingsActivity, "Failed to save user profile to server", Toast.LENGTH_SHORT).show()
                        }
                        // Reset button state
                        saveButton.isEnabled = true
                        saveButton.text = "Save Settings"
                    }
                }
            }
        })
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

    private fun markUnsavedChanges() {
        hasUnsavedChanges = true
        saveButton.text = "Save Settings *"
        saveButton.setBackgroundColor(ContextCompat.getColor(this, R.color.status_unavailable))
    }

    private fun markChangesSaved() {
        hasUnsavedChanges = false
        saveButton.text = "Save Settings"
        saveButton.setBackgroundColor(ContextCompat.getColor(this, R.color.primaryBlue))
    }
    
    private fun resetChangeTracking() {
        systemPromptChanged = false
        preferredNameChanged = false
        userAvatarChanged = false
        agentAvatarChanged = false
        newUserAvatarUri = null
        newAgentAvatarUri = null
    }

    override fun onBackPressed() {
        if (hasUnsavedChanges) {
            androidx.appcompat.app.AlertDialog.Builder(this)
                .setTitle("Unsaved Changes")
                .setMessage("You have unsaved changes. Do you want to save before leaving?")
                .setPositiveButton("Save") { _, _ ->
                    saveAllSettings()
                    super.onBackPressed()
                }
                .setNegativeButton("Discard") { _, _ ->
                    super.onBackPressed()
                }
                .setNeutralButton("Cancel", null)
                .show()
        } else {
            super.onBackPressed()
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
                newUserAvatarUri = uri
                userAvatarChanged = true
                userAvatar.setImageURI(null) // Clear cache
                userAvatar.setImageURI(uri)
                // Update AvatarManager immediately (without UUID since not saved yet)
                AvatarManager.setUserAvatar(uri, null)
                markUnsavedChanges()
            }
            AGENT_CROP -> {
                val uri = UCrop.getOutput(data) ?: return
                newAgentAvatarUri = uri
                agentAvatarChanged = true
                agentAvatar.setImageURI(null) // Clear cache
                agentAvatar.setImageURI(uri)
                // Update AvatarManager immediately (without UUID since not saved yet)
                AvatarManager.setAgentAvatar(uri, null)
                markUnsavedChanges()
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


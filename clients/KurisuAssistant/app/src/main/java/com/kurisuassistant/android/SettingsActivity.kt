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
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.IOException
import android.widget.ImageView
import android.widget.Toast
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import android.util.Patterns
import java.io.File

class SettingsActivity : AppCompatActivity() {

    private lateinit var userAvatar: ImageView
    private lateinit var agentAvatar: ImageView
    private lateinit var llmUrl: EditText
    private lateinit var ttsUrl: EditText
    private lateinit var modelSpinner: Spinner
    private val client = OkHttpClient()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        AvatarManager.init(this)
        Settings.init(this)

        userAvatar = findViewById(R.id.userAvatar)
        agentAvatar = findViewById(R.id.agentAvatar)
        llmUrl = findViewById(R.id.editLlmUrl)
        ttsUrl = findViewById(R.id.editTtsUrl)
        modelSpinner = findViewById(R.id.spinnerModel)

        llmUrl.setText(Settings.llmUrl)
        ttsUrl.setText(Settings.ttsUrl)

        AvatarManager.getUserAvatarUri()?.let { userAvatar.setImageURI(it) }
        AvatarManager.getAgentAvatarUri()?.let { agentAvatar.setImageURI(it) }

        userAvatar.setOnClickListener { pickImage(USER_PICK) }
        agentAvatar.setOnClickListener { pickImage(AGENT_PICK) }

        findViewById<Button>(R.id.buttonSaveSettings).setOnClickListener {
            Settings.save(
                llmUrl.text.toString().trim(),
                ttsUrl.text.toString().trim(),
                modelSpinner.selectedItem?.toString() ?: ""
            )
            Toast.makeText(this, "Settings saved", Toast.LENGTH_SHORT).show()
        }

        llmUrl.setOnFocusChangeListener { _, hasFocus ->
            if (!hasFocus) loadModels()
        }

        loadModels()
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
        if (!Patterns.WEB_URL.matcher(url).matches()) {
            runOnUiThread { modelSpinner.isEnabled = false }
            return
        }
        val request = Request.Builder()
            .url("$url/models")
            .addHeader("Authorization", "Bearer ${Auth.token ?: ""}")
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
                    }
                }
            }
        })
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


package com.kurisuassistant.android

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import androidx.appcompat.app.AppCompatActivity
import com.yalantis.ucrop.UCrop
import android.widget.ImageView
import java.io.File

class SettingsActivity : AppCompatActivity() {

    private lateinit var userAvatar: ImageView
    private lateinit var agentAvatar: ImageView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        AvatarManager.init(this)

        userAvatar = findViewById(R.id.userAvatar)
        agentAvatar = findViewById(R.id.agentAvatar)

        AvatarManager.getUserAvatarUri()?.let { userAvatar.setImageURI(it) }
        AvatarManager.getAgentAvatarUri()?.let { agentAvatar.setImageURI(it) }

        userAvatar.setOnClickListener { pickImage(USER_PICK) }
        agentAvatar.setOnClickListener { pickImage(AGENT_PICK) }
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


package com.kurisuassistant.android

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import io.noties.markwon.Markwon
import com.kurisuassistant.android.model.ChatMessage

/**
 * RecyclerView adapter displaying chat messages.
 */
class ChatAdapter(
    private val context: Context,
    private var messages: List<ChatMessage>,
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    companion object {
        private const val USER = 0
        private const val ASSISTANT = 1
    }

    private var responding = false
    private var ellipsis = ""
    private val markwon = Markwon.create(context)
    private val handler = Handler(Looper.getMainLooper())
    private val animateRunnable = object : Runnable {
        override fun run() {
            ellipsis = when (ellipsis.length) {
                0 -> "."
                1 -> ".."
                2 -> "..."
                else -> ""
            }
            if (messages.isNotEmpty()) notifyItemChanged(messages.lastIndex)
            if (responding) {
                handler.postDelayed(this, 500)
            }
        }
    }

    fun update(newMessages: List<ChatMessage>) {
        messages = newMessages
        notifyDataSetChanged()
    }

    fun setResponding(value: Boolean) {
        if (responding == value) return
        responding = value
        if (value) {
            handler.post(animateRunnable)
        } else {
            handler.removeCallbacks(animateRunnable)
            ellipsis = ""
            if (messages.isNotEmpty()) notifyItemChanged(messages.lastIndex)
        }
    }

    override fun getItemViewType(position: Int): Int = if (messages[position].isUser) USER else ASSISTANT

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        return if (viewType == USER) {
            val view = inflater.inflate(R.layout.item_user_message, parent, false)
            UserHolder(view)
        } else {
            val view = inflater.inflate(R.layout.item_assistant_message, parent, false)
            AssistantHolder(view)
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        val msg = messages[position]
        when (holder) {
            is UserHolder -> {
                markwon.setMarkdown(holder.text, msg.text)
                holder.time.text = msg.createdAt ?: ""
                val uri = AvatarManager.getUserAvatarUri()
                if (uri != null) holder.avatar.setImageURI(uri)
                else holder.avatar.setImageResource(R.drawable.avatar_user)
            }
            is AssistantHolder -> {
                var text = msg.text
                if (responding && position == messages.lastIndex) {
                    text += ellipsis
                }
                markwon.setMarkdown(holder.text, text)
                holder.time.text = msg.createdAt ?: ""
                val uri = AvatarManager.getAgentAvatarUri()
                if (uri != null) holder.avatar.setImageURI(uri)
                else holder.avatar.setImageResource(R.drawable.avatar_assistant)
            }
        }
    }

    override fun getItemCount(): Int = messages.size

    class UserHolder(view: View) : RecyclerView.ViewHolder(view) {
        val text: TextView = view.findViewById(R.id.message_text)
        val time: TextView = view.findViewById(R.id.message_time)
        val avatar: ImageView = view.findViewById(R.id.avatar)
    }

    class AssistantHolder(view: View) : RecyclerView.ViewHolder(view) {
        val text: TextView = view.findViewById(R.id.message_text)
        val time: TextView = view.findViewById(R.id.message_time)
        val avatar: ImageView = view.findViewById(R.id.avatar)
    }
}


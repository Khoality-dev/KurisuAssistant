package com.kurisuassistant.android

import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.widget.EditText
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import android.widget.ListView
import android.widget.Button
import android.widget.LinearLayout
import com.kurisuassistant.android.Settings
import androidx.activity.viewModels
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.drawerlayout.widget.DrawerLayout
import androidx.appcompat.app.ActionBarDrawerToggle
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.kurisuassistant.android.silerovad.SileroVadOnnxModel
import com.kurisuassistant.android.utils.Util
import com.kurisuassistant.android.AvatarManager
import com.google.android.material.appbar.MaterialToolbar


class MainActivity : AppCompatActivity() {
    companion object {
        private const val REQUEST_RECORD_AUDIO = 1001
        private const val TAG = "MainActivity"
    }
    val SAMPLE_RATE: Int = 16000
    val THRESHOLD: Float = 0.5f
    val MIN_SPEECH_DURATION_MS: Int = 250
    val MAX_SPEECH_DURATION_SECONDS: Float = Float.POSITIVE_INFINITY
    val MIN_SILENCE_DURATION_MS: Int = 100
    val SPEECH_PAD_MS: Int = 30
    lateinit var vadModel: SileroVadOnnxModel
    private val viewModel: ChatViewModel by viewModels()
    private lateinit var adapter: ChatAdapter
    private lateinit var drawerLayout: DrawerLayout
    private lateinit var drawerToggle: ActionBarDrawerToggle
    private lateinit var drawerAdapter: ConversationAdapter
    private lateinit var layoutManager: LinearLayoutManager
    private lateinit var recyclerView: RecyclerView
    private var responding: Boolean = false
    private var snapToLastMessage: Boolean = true // Flag to auto-scroll to new messages

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        val toolbar = findViewById<MaterialToolbar>(R.id.toolbar)
        setSupportActionBar(toolbar)
        
        // Initialize toolbar title
        updateToolbarTitle()
        ChatRepository.init(this)

        drawerLayout = findViewById(R.id.drawerLayout)
        drawerToggle = ActionBarDrawerToggle(this, drawerLayout, toolbar, R.string.drawer_open, R.string.drawer_close)
        drawerLayout.addDrawerListener(drawerToggle)
        drawerLayout.addDrawerListener(object : DrawerLayout.DrawerListener {
            override fun onDrawerSlide(drawerView: View, slideOffset: Float) {}
            override fun onDrawerOpened(drawerView: View) {
                // Fetch conversations when drawer is opened
                ChatRepository.refreshConversationList {
                    refreshDrawer()
                }
            }
            override fun onDrawerClosed(drawerView: View) {}
            override fun onDrawerStateChanged(newState: Int) {}
        })
        drawerToggle.syncState()
        val convList = findViewById<ListView>(R.id.listConversations)
        val newChat = findViewById<Button>(R.id.buttonNewChat)
        val mcpTools = findViewById<Button>(R.id.buttonMcpTools)
        drawerAdapter = ConversationAdapter(
            this,
            emptyList(), // Start with empty list
            onItemClick = { actualIndex ->
                ChatRepository.switchConversation(actualIndex)
                drawerLayout.closeDrawers()
                refreshDrawer()
                updateToolbarTitle()
            },
            onItemDelete = { actualIndex ->
                deleteConversation(actualIndex)
            }
        )
        convList.adapter = drawerAdapter
        newChat.setOnClickListener {
            ChatRepository.startNewConversation()
            drawerLayout.closeDrawers()
            refreshDrawer()
            updateToolbarTitle()
        }
        mcpTools.setOnClickListener {
            startActivity(Intent(this, MCPToolsActivity::class.java))
            drawerLayout.closeDrawers()
        }
        Settings.init(this)
        AvatarManager.init(this)
        Util.checkPermissions(this)

        val swipeRefreshLayout = findViewById<SwipeRefreshLayout>(R.id.swipeRefreshLayout)
        recyclerView = findViewById<RecyclerView>(R.id.recyclerView)
        adapter = ChatAdapter(this, viewModel.messages.value ?: emptyList())
        recyclerView.adapter = adapter
        layoutManager = LinearLayoutManager(this)
        recyclerView.layoutManager = layoutManager
        
        // Add scroll listener for loading older messages and tracking snap-to-bottom state
        recyclerView.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) {
                super.onScrolled(recyclerView, dx, dy)
                
                // Update snap-to-last-message flag based on scroll direction and position
                val totalItems = layoutManager.itemCount
                val lastVisibleItem = layoutManager.findLastVisibleItemPosition()
                
                if (dy > 0) { // Scrolling down
                    // Check if user scrolled to the last message
                    if (lastVisibleItem >= totalItems - 1) {
                        snapToLastMessage = true
                        println("MainActivity: User scrolled to bottom - snapToLastMessage = true")
                    }
                } else if (dy < 0) { // Scrolling up
                    // User scrolled up, disable auto-scroll
                    snapToLastMessage = false
                    println("MainActivity: User scrolled up - snapToLastMessage = false")
                }
                
                // Check if user scrolled near the top and there might be older messages
                val firstVisibleItem = layoutManager.findFirstVisibleItemPosition()
                
                if (dy < 0) { // Only log when scrolling up
                    println("MainActivity: Scroll up - firstVisible: $firstVisibleItem, totalItems: $totalItems, dy: $dy")
                }
                
                if (firstVisibleItem <= 1 && dy < 0) { // Load when within 1 item of top and scrolling up
                    println("MainActivity: Scroll up detected, loading older messages...")
                    ChatRepository.loadOlderMessages { hasMore ->
                        if (hasMore) {
                            println("MainActivity: Loaded older messages successfully")
                        }
                    }
                }
            }
        })
        
        // Setup pull-to-refresh
        swipeRefreshLayout.setOnRefreshListener {
            refreshConversationList(swipeRefreshLayout)
        }

        val editText = findViewById<EditText>(R.id.editTextMessage)
        val sendButton = findViewById<ImageButton>(R.id.buttonSend)
        val recordButton = findViewById<ImageButton>(R.id.buttonRecord)
        val recordIndicator = findViewById<TextView>(R.id.recordIndicator)
        val connectionIndicator = findViewById<ImageView>(R.id.connectionIndicator)
        val emptyStateLayout = findViewById<LinearLayout>(R.id.emptyStateLayout)
        var isRecording = false

        viewModel.messages.observe(this) {
            adapter.update(it)
            
            // Show/hide empty state based on message count
            val hasMessages = !it.isNullOrEmpty()
            if (hasMessages) {
                emptyStateLayout.visibility = View.GONE
                recyclerView.visibility = View.VISIBLE
                recyclerView.post {
                    
                    // Auto-scroll to bottom if snapToLastMessage flag is true
                    if (snapToLastMessage && it.isNotEmpty()) {
                        println("MainActivity: Auto-scrolling to bottom (${it.size} messages)")
                        recyclerView.smoothScrollToPosition(it.size - 1)
                    }
                }
            } else {
                emptyStateLayout.visibility = View.VISIBLE
                recyclerView.visibility = View.GONE
            }
            
            // Update toolbar title when messages change (conversation loaded)
            updateToolbarTitle()
        }

        // Removed layout change listener - no auto-scrolling on layout changes

        viewModel.connected.observe(this) { connected ->
            val res = if (connected) android.R.drawable.presence_online
            else android.R.drawable.presence_offline
            connectionIndicator.setImageResource(res)
            
            // Enable/disable chat controls based on connection status
            sendButton.isEnabled = connected
            recordButton.isEnabled = connected
            editText.isEnabled = connected
            
            // Update visual appearance of disabled controls
            val enabledColor = ContextCompat.getColor(this, R.color.primaryBlue)
            val disabledColor = ContextCompat.getColor(this, android.R.color.darker_gray)
            
            sendButton.setColorFilter(if (connected) enabledColor else disabledColor)
            recordButton.setColorFilter(if (connected) enabledColor else disabledColor)
            editText.setTextColor(if (connected) 
                ContextCompat.getColor(this, R.color.black) else disabledColor)
            
            // Update hint text based on connection status
            editText.hint = if (connected) "Type a message..." else "No connection - check server status"
        }

        viewModel.typing.observe(this) { typing ->
            updateResponding(typing || (viewModel.speaking.value == true))
        }

        viewModel.speaking.observe(this) { speaking ->
            updateResponding(speaking || (viewModel.typing.value == true))
        }

        sendButton.setOnClickListener {
            val text = editText.text.toString().trim()
            if (text.isNotEmpty() && viewModel.connected.value == true) {
                viewModel.sendMessage(text)
                editText.text.clear()
            } else if (viewModel.connected.value == false) {
                Toast.makeText(this, "No connection to server", Toast.LENGTH_SHORT).show()
            }
        }

        recordButton.setOnClickListener {
            if (viewModel.connected.value == false) {
                Toast.makeText(this, "No connection to server", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            
            if (isRecording) {
                stopRecordingService()
                recordIndicator.visibility = View.GONE
            } else {
                startRecordingService()
                recordIndicator.visibility = View.VISIBLE
            }
            isRecording = !isRecording
        }
    }

    private fun updateResponding(value: Boolean) {
        if (responding == value) return
        responding = value
        adapter.setResponding(value)
    }

    private fun startRecordingService() {
        val intent = Intent(this, RecordingService::class.java)
        ContextCompat.startForegroundService(this, intent)
        Log.d(TAG, "RecordingService spawned")
        Toast.makeText(this, "Recording started", Toast.LENGTH_SHORT).show()
    }

    private fun stopRecordingService() {
        val intent = Intent(this, RecordingService::class.java)
        stopService(intent)
        Log.d(TAG, "RecordingService stopped")
        Toast.makeText(this, "Recording stopped", Toast.LENGTH_SHORT).show()
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.menu_main, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.action_settings -> {
                startActivity(Intent(this, SettingsActivity::class.java))
                true
            }
            else -> super.onOptionsItemSelected(item)
        }
    }

    private fun refreshConversationList(swipeRefreshLayout: SwipeRefreshLayout) {
        // Show loading indicator
        swipeRefreshLayout.isRefreshing = true
        
        // Use a coroutine to refresh conversations
        viewModel.refreshConversationList {
            // Hide loading indicator when done
            runOnUiThread {
                swipeRefreshLayout.isRefreshing = false
                refreshDrawer()
                updateToolbarTitle()
            }
        }
    }
    
    private fun updateToolbarTitle() {
        val currentIndex = ChatRepository.getCurrentConversationIndex()
        val title = ChatHistory.getCurrentConversationTitle(currentIndex)
        supportActionBar?.title = title
    }

    override fun onDestroy() {
        super.onDestroy()
        adapter.onDestroy()
        ChatRepository.destroy()
    }

    private fun refreshDrawer() {
        val convList = findViewById<ListView>(R.id.listConversations)
        val conversationTitles = ChatHistory.conversationTitles()
        
        println("MainActivity: refreshDrawer() called with ${conversationTitles.size} conversations")
        
        // Show all conversations for now to debug
        drawerAdapter.updateConversations(conversationTitles)
        
        // Show/hide conversation list based on whether there are any conversations
        if (conversationTitles.isEmpty()) {
            convList.visibility = View.GONE
            println("MainActivity: Hiding conversation list - no conversations")
        } else {
            convList.visibility = View.VISIBLE
            println("MainActivity: Showing ${conversationTitles.size} conversations")
            
            // Highlight the active conversation
            val currentIndex = ChatRepository.getCurrentConversationIndex()
            if (currentIndex >= 0 && currentIndex < ChatHistory.size) {
                drawerAdapter.setActiveConversation(currentIndex)
                println("MainActivity: Highlighting conversation at index $currentIndex")
            } else {
                drawerAdapter.setActiveConversation(-1)
                println("MainActivity: No highlighting - invalid current index: $currentIndex")
            }
        }
    }
    
    private fun deleteConversation(index: Int) {
        if (ChatHistory.size <= 1) {
            Toast.makeText(this, "Cannot delete the last conversation", Toast.LENGTH_SHORT).show()
            return
        }
        
        ChatRepository.deleteConversation(index) { success ->
            if (success) {
                refreshDrawer()
                updateToolbarTitle()
                Toast.makeText(this, "Conversation deleted", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(this, "Failed to delete conversation", Toast.LENGTH_SHORT).show()
            }
        }
    }

}
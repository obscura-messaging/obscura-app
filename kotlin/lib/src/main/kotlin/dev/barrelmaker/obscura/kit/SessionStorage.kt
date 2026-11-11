package dev.barrelmaker.obscura.kit

/** Platform storage for the session blob. [save] replaces the whole blob. */
interface SessionStorage {
    fun save(data: Map<String, String>)
    fun load(): Map<String, String>?
    fun clear()
}

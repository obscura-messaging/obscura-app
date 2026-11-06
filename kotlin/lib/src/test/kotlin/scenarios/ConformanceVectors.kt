package scenarios

import org.json.JSONObject
import java.io.File

/** A vector file from `protocol/conformance/`, found from the Gradle working directory. */
fun loadVectors(name: String): JSONObject {
    val candidates = listOf(
        "../../protocol/conformance/$name",
        "../protocol/conformance/$name",
        "protocol/conformance/$name",
    )
    val file = candidates.map(::File).firstOrNull { it.exists() }
        ?: error(
            "conformance vector '$name' not found (looked in: ${candidates.joinToString()}). " +
                "Is protocol/conformance present in the repository checkout?",
        )
    return JSONObject(file.readText())
}

fun String.hex(): ByteArray = chunked(2).map { it.toInt(16).toByte() }.toByteArray()

fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }

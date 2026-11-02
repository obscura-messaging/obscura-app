package scenarios

import com.google.protobuf.ByteString
import dev.barrelmaker.obscura.kit.TypingState
import dev.barrelmaker.obscura.kit.wire.WireCodec
import obscura.client.v1.Client
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory

class WireConformanceTest {

    @TestFactory
    fun `wire conformance`(): List<DynamicTest> {
        val v = loadVectors("wire.json")
        val tests = mutableListOf<DynamicTest>()

        forEach(v.getJSONArray("messageTypes")) { c ->
            val wire = c.getString("wire"); val app = c.getString("app")
            tests.add(dyn("messageType $wire -> \"$app\"") {
                val case = Client.ClientMessage.PayloadCase.valueOf(wire.uppercase())
                assertEquals(app, WireCodec.kind(case))
            })
        }

        forEach(v.getJSONArray("typingStates")) { c ->
            val wire = c.getString("wire"); val app = c.getString("app")
            tests.add(dyn("typingState $wire <-> \"$app\"") {
                val wireState = Client.TypingState.valueOf(wire)
                val appState = TypingState.valueOf(app.uppercase())
                assertEquals(appState, WireCodec.decodeTypingState(wireState), "decode $wire")
                assertEquals(wireState, WireCodec.encodeTypingState(appState), "encode $app")
            })
        }

        forEach(v.getJSONArray("roundTrip")) { c ->
            tests.add(dyn(c.getString("name")) { roundTrip(c.getJSONObject("appEntry")) })
        }

        return tests
    }

    private fun roundTrip(ms: JSONObject) {
        val model = ms.getString("model")
        val id = ms.getString("id")
        val ts = ms.getLong("timestamp")
        val dataMap = ms.getJSONObject("data").toMap()

        val proto = Client.AppEntry.newBuilder()
            .setModel(model)
            .setId(id)
            .setTimestamp(ts)
            .setData(ByteString.copyFrom(JSONObject(dataMap).toString().toByteArray()))
            .build()

        val decoded = Client.AppEntry.parseFrom(proto.toByteArray())

        assertEquals(model, decoded.model, "model")
        assertEquals(id, decoded.id, "id")
        assertEquals(ts, decoded.timestamp, "timestamp")
        assertEquals(dataMap, JSONObject(String(decoded.data.toByteArray())).toMap(), "data value")
    }

    private fun dyn(name: String, exec: () -> Unit) = DynamicTest.dynamicTest(name, exec)

    private inline fun forEach(arr: org.json.JSONArray, body: (JSONObject) -> Unit) {
        for (i in 0 until arr.length()) body(arr.getJSONObject(i))
    }
}

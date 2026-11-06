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
            tests.add(dyn(c.getString("name")) { roundTrip(c) })
        }

        return tests
    }

    private fun roundTrip(case: JSONObject) {
        when {
            case.has("directMessage") -> {
                val dm = case.getJSONObject("directMessage")
                val proto = Client.ClientMessage.newBuilder()
                    .setTimestamp(dm.getLong("timestamp"))
                    .setDirectMessage(
                        Client.DirectMessage.newBuilder()
                            .setId(dm.getString("id"))
                            .setPeerUserId(dm.getString("peerUserId"))
                            .setContent(dm.getString("content")),
                    )
                    .build()
                val decoded = Client.ClientMessage.parseFrom(proto.toByteArray())
                assertEquals(dm.getLong("timestamp"), decoded.timestamp, "timestamp")
                assertEquals(dm.getString("id"), decoded.directMessage.id, "id")
                assertEquals(dm.getString("peerUserId"), decoded.directMessage.peerUserId, "peerUserId")
                assertEquals(dm.getString("content"), decoded.directMessage.content, "content")
            }
            case.has("pix") -> {
                val px = case.getJSONObject("pix")
                val proto = Client.ClientMessage.newBuilder()
                    .setTimestamp(px.getLong("timestamp"))
                    .setPix(
                        Client.PixMessage.newBuilder()
                            .setId(px.getString("id"))
                            .setPeerUserId(px.getString("peerUserId"))
                            .setAttachment(
                                Client.AttachmentPointer.newBuilder()
                                    .setId(px.getString("attachmentId"))
                                    .setContentKey(ByteString.copyFrom(px.getString("contentKey").hex()))
                                    .setNonce(ByteString.copyFrom(px.getString("nonce").hex()))
                                    .setMediaType(px.getString("mediaType")),
                            )
                            .setCaption(px.getString("caption"))
                            .setCaptionMeta(px.getString("captionMeta"))
                            .setDisplayDurationSecs(px.getInt("displayDurationSecs")),
                    )
                    .build()
                val decoded = Client.ClientMessage.parseFrom(proto.toByteArray())
                assertEquals(px.getLong("timestamp"), decoded.timestamp, "timestamp")
                assertEquals(px.getString("id"), decoded.pix.id, "id")
                assertEquals(px.getString("peerUserId"), decoded.pix.peerUserId, "peerUserId")
                assertEquals(px.getString("attachmentId"), decoded.pix.attachment.id, "attachmentId")
                assertEquals(px.getString("contentKey"), decoded.pix.attachment.contentKey.toByteArray().hex(), "contentKey")
                assertEquals(px.getString("nonce"), decoded.pix.attachment.nonce.toByteArray().hex(), "nonce")
                assertEquals(px.getString("mediaType"), decoded.pix.attachment.mediaType, "mediaType")
                assertEquals(px.getString("caption"), decoded.pix.caption, "caption")
                assertEquals(px.getString("captionMeta"), decoded.pix.captionMeta, "captionMeta")
                assertEquals(px.getInt("displayDurationSecs"), decoded.pix.displayDurationSecs, "displayDurationSecs")
            }
            else -> error("unexpected roundTrip case: $case")
        }
    }

    private fun dyn(name: String, exec: () -> Unit) = DynamicTest.dynamicTest(name, exec)

    private inline fun forEach(arr: org.json.JSONArray, body: (JSONObject) -> Unit) {
        for (i in 0 until arr.length()) body(arr.getJSONObject(i))
    }

    @org.junit.jupiter.api.Test
    fun `WireCodec handles unrecognized enum values and blank friend userId`() {
        org.junit.jupiter.api.Assertions.assertNull(WireCodec.decodeTypingState(Client.TypingState.UNRECOGNIZED))
        val unrecognizedFriend = Client.FriendRecord.newBuilder()
            .setUserId("019f025a-0000-7de6-84b6-000000000002")
            .setUsername("alice")
            .setStatusValue(999)
            .build()
        org.junit.jupiter.api.Assertions.assertNull(WireCodec.decodeFriend(unrecognizedFriend))
        val blankIdFriend = Client.FriendRecord.newBuilder()
            .setUserId(" ")
            .setUsername("alice")
            .setStatus(Client.FriendStatus.FRIEND_STATUS_ACCEPTED)
            .build()
        org.junit.jupiter.api.Assertions.assertNull(WireCodec.decodeFriend(blankIdFriend))
    }
}

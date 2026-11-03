package dev.barrelmaker.obscura

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.media.ExifInterface
import java.io.File
import java.io.FileOutputStream

internal object ImageProcessor {
    class Result(val path: String, val width: Int, val height: Int)

    /**
     * Resize the image at [srcPath] so its largest side is at most [maxDim] px,
     * re-encoded as JPEG at [quality] (1-100). Honors the JPEG's EXIF
     * `Orientation` tag — the output pixels are already in display orientation
     * (front-camera selfies don't render rotated). Returns the new file path
     * plus its post-rotation dimensions. The original file is left untouched.
     *
     * Memory: uses `inSampleSize` two-pass decoding so a 12 MP source doesn't
     * allocate a 48 MB intermediate bitmap on low-memory devices.
     */
    fun resize(cacheDir: File, srcPath: String, maxDim: Int, quality: Int): Result {
        require(maxDim > 0) { "maxDim must be positive (got $maxDim)" }

        // Pass 1: read bounds only.
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(srcPath, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw IllegalArgumentException("Could not decode image at $srcPath")
        }

        // Pass 2: sub-sampled decode keeps peak memory bounded.
        val srcLargest = maxOf(bounds.outWidth, bounds.outHeight)
        var sample = 1
        while (sample * 2 <= srcLargest / maxDim) sample *= 2
        val decoded = BitmapFactory.decodeFile(
            srcPath,
            BitmapFactory.Options().apply { inSampleSize = sample },
        ) ?: throw IllegalArgumentException("Could not decode image at $srcPath")

        // EXIF orientation — both the rotation and the flip variants used by
        // Android front cameras. We bake the transform into the bitmap so the
        // output JPEG has display-orientation pixels and no orientation tag.
        val orientation = try {
            ExifInterface(srcPath).getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL,
            )
        } catch (_: Throwable) { ExifInterface.ORIENTATION_NORMAL }

        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.postRotate(90f); matrix.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.postRotate(-90f); matrix.postScale(-1f, 1f) }
        }

        // 90°/270° orientations swap apparent width/height for the scale check.
        val swap = orientation == ExifInterface.ORIENTATION_ROTATE_90 ||
            orientation == ExifInterface.ORIENTATION_ROTATE_270 ||
            orientation == ExifInterface.ORIENTATION_TRANSPOSE ||
            orientation == ExifInterface.ORIENTATION_TRANSVERSE
        val rotW = if (swap) decoded.height else decoded.width
        val rotH = if (swap) decoded.width else decoded.height
        val rotLargest = maxOf(rotW, rotH)
        val scale = if (rotLargest <= maxDim) 1.0 else maxDim.toDouble() / rotLargest
        if (scale != 1.0) matrix.postScale(scale.toFloat(), scale.toFloat())

        val output = Bitmap.createBitmap(
            decoded, 0, 0, decoded.width, decoded.height, matrix, true,
        )
        if (output !== decoded) decoded.recycle()

        val dir = File(cacheDir, "resized").apply { mkdirs() }
        val dest = File(dir, "img_${System.currentTimeMillis()}.jpg")
        FileOutputStream(dest).use { out ->
            output.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(1, 100), out)
        }
        val outW = output.width
        val outH = output.height
        output.recycle()

        return Result(dest.absolutePath, outW, outH)
    }

    /**
     * Write a solid-color JPEG of the requested size to [cacheDir] and return
     * its path and dimensions.
     */
    fun writeTestImage(cacheDir: File, width: Int, height: Int): Result {
        require(width in 1..8192 && height in 1..8192) {
            "dimensions out of range (got ${width}x${height})"
        }
        val color = Color.argb(
            255,
            (Math.random() * 256).toInt(),
            (Math.random() * 256).toInt(),
            (Math.random() * 256).toInt(),
        )
        val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bmp.eraseColor(color)
        val dest = File(cacheDir, "test_${System.currentTimeMillis()}.jpg")
        FileOutputStream(dest).use { out ->
            bmp.compress(Bitmap.CompressFormat.JPEG, 85, out)
        }
        bmp.recycle()
        return Result(dest.absolutePath, width, height)
    }
}

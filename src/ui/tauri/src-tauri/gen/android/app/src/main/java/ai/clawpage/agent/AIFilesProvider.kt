package ai.clawpage.agent

import android.database.Cursor
import android.database.MatrixCursor
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileNotFoundException

// The agent's folder (DeviceFiles.kt) in the system Files app, under the app's name, as the iPhone app's shows in
// its Files app: the person opens what the agent put there, adds files for it, and deletes or renames them. Only
// the system's document UI can bind to it (MANAGE_DOCUMENTS); nothing outside the folder is offered.

class AIFilesProvider : DocumentsProvider() {
  private val rootColumns = arrayOf(Root.COLUMN_ROOT_ID, Root.COLUMN_FLAGS, Root.COLUMN_ICON, Root.COLUMN_TITLE, Root.COLUMN_DOCUMENT_ID)
  private val documentColumns = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS)

  override fun onCreate(): Boolean {
    DeviceFiles.init(context!!)
    return true
  }

  /** Document ids are paths inside the folder under "root" ("root" is the folder itself); nothing that climbs out of it. */
  private fun fileOf(id: String): File {
    if (id != ROOT && !id.startsWith("$ROOT/")) throw FileNotFoundException(id)
    val base = DeviceFiles.root.canonicalFile
    val file = File(base, id.removePrefix(ROOT)).canonicalFile
    if (file != base && !file.path.startsWith(base.path + File.separator)) throw FileNotFoundException(id)
    return file
  }

  private fun idOf(file: File): String = file.canonicalFile.relativeTo(DeviceFiles.root.canonicalFile).path.let { if (it.isEmpty()) ROOT else "$ROOT/$it" }

  private fun mime(file: File): String = if (file.isDirectory) Document.MIME_TYPE_DIR
    else MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase()) ?: "application/octet-stream"

  private fun row(cursor: MatrixCursor, file: File) {
    val flags = if (file.isDirectory) Document.FLAG_DIR_SUPPORTS_CREATE else Document.FLAG_SUPPORTS_WRITE
    val editable = if (idOf(file) == ROOT) 0 else Document.FLAG_SUPPORTS_DELETE or Document.FLAG_SUPPORTS_RENAME
    cursor.newRow().add(Document.COLUMN_DOCUMENT_ID, idOf(file)).add(Document.COLUMN_DISPLAY_NAME, if (idOf(file) == ROOT) context!!.getString(R.string.app_name) else file.name)
      .add(Document.COLUMN_MIME_TYPE, mime(file)).add(Document.COLUMN_SIZE, if (file.isFile) file.length() else null)
      .add(Document.COLUMN_LAST_MODIFIED, file.lastModified()).add(Document.COLUMN_FLAGS, flags or editable)
  }

  override fun queryRoots(projection: Array<out String>?): Cursor = MatrixCursor(projection ?: rootColumns).apply {
    newRow().add(Root.COLUMN_ROOT_ID, "ai-files").add(Root.COLUMN_FLAGS, Root.FLAG_SUPPORTS_CREATE or Root.FLAG_LOCAL_ONLY)
      .add(Root.COLUMN_ICON, R.mipmap.ic_launcher).add(Root.COLUMN_TITLE, context!!.getString(R.string.app_name)).add(Root.COLUMN_DOCUMENT_ID, ROOT)
  }

  override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor =
    MatrixCursor(projection ?: documentColumns).apply { row(this, fileOf(documentId)) }

  override fun queryChildDocuments(parentDocumentId: String, projection: Array<out String>?, sortOrder: String?): Cursor =
    MatrixCursor(projection ?: documentColumns).apply {
      fileOf(parentDocumentId).listFiles()?.filter { !it.name.startsWith(".") }?.forEach { row(this, it) }
    }

  override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean =
    fileOf(documentId).path.startsWith(fileOf(parentDocumentId).path + File.separator)

  override fun openDocument(documentId: String, mode: String, signal: CancellationSignal?): ParcelFileDescriptor {
    val file = fileOf(documentId)
    if (!file.isFile) throw FileNotFoundException(documentId)
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode))
  }

  /** A name already there gets " (2)", " (3)", … as when the agent puts a file here. */
  override fun createDocument(parentDocumentId: String, mimeType: String, displayName: String): String {
    val parent = fileOf(parentDocumentId)
    val name = displayName.replace('/', '_').ifEmpty { "file" }
    val dot = name.lastIndexOf('.')
    var target = File(parent, name)
    var n = 2
    while (target.exists()) target = File(parent, if (dot > 0) "${name.substring(0, dot)} ($n)${name.substring(dot)}" else "$name ($n)").also { n++ }
    val made = if (mimeType == Document.MIME_TYPE_DIR) target.mkdir() else target.createNewFile()
    if (!made) throw FileNotFoundException(displayName)
    return idOf(target)
  }

  override fun deleteDocument(documentId: String) {
    val file = fileOf(documentId)
    if (idOf(file) == ROOT || !file.deleteRecursively()) throw FileNotFoundException(documentId)
  }

  override fun renameDocument(documentId: String, displayName: String): String {
    val file = fileOf(documentId)
    val target = File(file.parentFile, displayName.replace('/', '_'))
    if (idOf(file) == ROOT || target.exists() || !file.renameTo(target)) throw FileNotFoundException(displayName)
    return idOf(target)
  }

  private companion object { const val ROOT = "root" }
}

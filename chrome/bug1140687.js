function RemoveSelectedAttachment()
{
  let bucket = document.getElementById("attachmentBucket");
  if (bucket.selectedItems.length > 0) {
    let fileHandler = Services.io.getProtocolHandler("file")
                              .QueryInterface(Components.interfaces.nsIFileProtocolHandler);
    let removedAttachments = Components.classes["@mozilla.org/array;1"]
                                       .createInstance(Components.interfaces.nsIMutableArray);

    for (let i = bucket.selectedCount - 1; i >= 0; i--) {
      let item = bucket.removeItemAt(bucket.getIndexOfItem(bucket.getSelectedItem(i)));
      if (item.attachment.size != -1) {
        gAttachmentsSize -= item.attachment.size;
        UpdateAttachmentBucket(true);
      }

      if (item.attachment.sendViaCloud && item.cloudProvider) {
        let originalUrl = item.originalUrl, file;
        if (!originalUrl)
          originalUrl = item.attachment.url;
        file = fileHandler.getFileFromURLSpec(originalUrl);
        if (item.uploading)
          item.cloudProvider.cancelFileUpload(file);
        else
          item.cloudProvider.deleteFile(file,
            new deletionListener(item.attachment, item.cloudProvider));
      }

      removedAttachments.appendElement(item.attachment, false);
      // Let's release the attachment object held by the node else it won't go
      // away until the window is destroyed
      item.attachment = null;
    }

    gContentChanged = true;
    dispatchAttachmentBucketEvent("attachments-removed", removedAttachments);
  }
  CheckForAttachmentNotification(null);
}

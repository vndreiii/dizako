#!/bin/bash
TOKEN="bbffc0b9fb8dbcd4b62532c2550e075258564082"
REPO_API="https://code.milfs.party/api/v1/repos/alex/dizako"

echo "Creating release v1.1.0..."
RELEASE_ID=$(curl -s -X POST "$REPO_API/releases" \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tag_name": "v1.1.0",
    "name": "Dizako v1.1.0",
    "body": "Dizako 1.1.0 Hotfix Release.\n- Removed viewport label from FAB\n- Fixed sub-pixel text rendering blur\n- Replaced zoom icons with standard Material icons",
    "draft": false,
    "prerelease": false
  }' | grep -oP '"id":\K\d+' | head -n 1)

if [ -z "$RELEASE_ID" ]; then
    echo "Fetching existing release ID..."
    RELEASE_ID=$(curl -s -X GET "$REPO_API/releases/tags/v1.1.0" \
      -H "Authorization: token $TOKEN" | grep -oP '"id":\K\d+' | head -n 1)
fi

echo "Release ID: $RELEASE_ID"

if [ -n "$RELEASE_ID" ]; then
    echo "Uploading PKGBUILD..."
    curl -s -X POST "$REPO_API/releases/$RELEASE_ID/assets" \
      -H "Authorization: token $TOKEN" \
      -F "attachment=@packaging/PKGBUILD;filename=PKGBUILD"

    ARCH_PKG=$(ls packaging/dizako-git-*.pkg.tar.zst | head -n 1)
    if [ -f "$ARCH_PKG" ]; then
        echo "Uploading $ARCH_PKG..."
        curl -s -X POST "$REPO_API/releases/$RELEASE_ID/assets" \
          -H "Authorization: token $TOKEN" \
          -F "attachment=@$ARCH_PKG"
    fi

    DEB_PKG=$(ls packaging/src/dizako/src-tauri/target/release/bundle/deb/*.deb | head -n 1)
    if [ -f "$DEB_PKG" ]; then
        echo "Uploading $DEB_PKG..."
        curl -s -X POST "$REPO_API/releases/$RELEASE_ID/assets" \
          -H "Authorization: token $TOKEN" \
          -F "attachment=@$DEB_PKG"
    fi

    RPM_PKG=$(ls packaging/src/dizako/src-tauri/target/release/bundle/rpm/*.rpm | head -n 1)
    if [ -f "$RPM_PKG" ]; then
        echo "Uploading $RPM_PKG..."
        curl -s -X POST "$REPO_API/releases/$RELEASE_ID/assets" \
          -H "Authorization: token $TOKEN" \
          -F "attachment=@$RPM_PKG"
    fi
    echo "Done!"
fi

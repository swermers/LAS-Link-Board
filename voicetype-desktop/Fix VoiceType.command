#!/bin/bash
# ============================================================
# Fix VoiceType — removes macOS quarantine flag
# Double-click this file to fix the "damaged" error
# ============================================================

echo ""
echo "🔧 Fixing VoiceType..."
echo ""

# Common locations to check
FOUND=0
for APP_PATH in \
  "$HOME/Applications/VoiceType.app" \
  "/Applications/VoiceType.app" \
  "$HOME/Documents/VoiceType.app" \
  "$HOME/Downloads/VoiceType.app" \
  "$HOME/Desktop/VoiceType.app"; do
  if [ -e "$APP_PATH" ]; then
    echo "Found VoiceType at: $APP_PATH"
    xattr -cr "$APP_PATH"
    echo "✅ Fixed! You can now open VoiceType."
    FOUND=1
    break
  fi
done

if [ "$FOUND" -eq 0 ]; then
  echo "Could not find VoiceType.app in the usual locations."
  echo ""
  echo "Please drag VoiceType.app onto this Terminal window and press Enter:"
  read -r CUSTOM_PATH
  CUSTOM_PATH=$(echo "$CUSTOM_PATH" | sed "s/^ *//;s/ *$//;s/\\\\//g")
  if [ -e "$CUSTOM_PATH" ]; then
    xattr -cr "$CUSTOM_PATH"
    echo "✅ Fixed! You can now open VoiceType."
  else
    echo "❌ Could not find that path. Please move VoiceType.app to your Applications folder and try again."
  fi
fi

echo ""
echo "You can close this window now."
read -n 1 -s -r -p "Press any key to close..."

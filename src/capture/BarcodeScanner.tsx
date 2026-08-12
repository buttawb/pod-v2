import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { BottomBar, Button, colors, spacing, type } from '../ui/components';

/**
 * Scanning is the fast path; the brief allows a manual barcode too, so a
 * refused permission or an unreadable label never blocks the capture - the
 * caller keeps its text field either way.
 */
export function BarcodeScanner({
  onScanned,
  onCancel,
}: {
  onScanned: (value: string) => void;
  onCancel: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [handled, setHandled] = useState(false);

  if (!permission) return <View style={styles.container} />;

  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <View style={styles.message}>
          <Text style={type.body}>Camera access is needed to scan a barcode.</Text>
          <Text style={type.small}>You can still type the barcode by hand.</Text>
        </View>
        <BottomBar>
          <Button label="Allow camera" onPress={() => void requestPermission()} />
          <Button label="Type it instead" variant="secondary" onPress={onCancel} />
        </BottomBar>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={styles.camera}
        barcodeScannerSettings={{
          barcodeTypes: ['code128', 'code39', 'ean13', 'ean8', 'qr', 'itf14', 'upc_a'],
        }}
        onBarcodeScanned={({ data }) => {
          if (handled) return; // one scan per visit; the camera fires repeatedly
          setHandled(true);
          onScanned(data);
        }}
      />
      <View style={styles.reticleLayer} pointerEvents="none">
        <View style={styles.reticle} />
      </View>
      <BottomBar>
        <Button label="Type it instead" variant="secondary" onPress={onCancel} />
      </BottomBar>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.text },
  camera: { flex: 1 },
  message: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: spacing.sm, padding: spacing.lg },
  // Centred rather than pinned to a percentage from the top: rotated, the
  // screen is barely 400dp tall and a fixed offset put the reticle off centre.
  reticleLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reticle: {
    width: '78%',
    maxWidth: 460,
    aspectRatio: 2.4,
    maxHeight: '55%',
    borderWidth: 3,
    borderColor: '#FFFFFF',
    borderRadius: 12,
  },
});

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { BottomBar, Button, Card, Screen, spacing, type } from '../ui/components';
import { RouteMapScreen } from '../maps/RouteMapScreen';
import { DepotMapScreen } from '../maps/DepotMapScreen';

type Surface = 'menu' | 'route' | 'depot';

export function MapsScreen({
  onOpenStop,
  onBack,
}: {
  onOpenStop: (stopId: string) => void;
  onBack: () => void;
}) {
  const [surface, setSurface] = useState<Surface>('menu');

  if (surface === 'route') {
    return <RouteMapScreen onOpenStop={onOpenStop} onBack={() => setSurface('menu')} />;
  }
  if (surface === 'depot') {
    return <DepotMapScreen onBack={() => setSurface('menu')} />;
  }

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={type.title}>Maps</Text>
      </View>

      <Card onPress={() => setSurface('route')}>
        <Text style={type.bodyStrong}>My route</Text>
        <Text style={type.small}>Your stops and live position. Tap a pin to open the stop.</Text>
      </Card>

      <Card onPress={() => setSurface('depot')}>
        <Text style={type.bodyStrong}>Depot overview</Text>
        <Text style={type.small}>Every stop in the coverage area, filterable by status.</Text>
      </Card>

      <BottomBar>
        <Button label="Back to today" variant="secondary" onPress={onBack} />
      </BottomBar>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { padding: spacing.md },
});
